# electron-cdp-remote

用 Chrome DevTools Protocol **遥控一个带调试守卫的 Electron 桌面客户端**。

不用 Playwright，不用 Puppeteer，**零第三方依赖**。

针对网页浏览器的自动化工具已经很多，针对**随客户端一起发布的桌面版应用**的自动化工具却几乎没有。这个库补的就是这块：它能接管正在运行的 Electron 应用，给你一个真实的 `Runtime.evaluate`，于是你可以读取和操作它自己的 DOM——不是网页，不是模拟点击，而是真正的 DOM。

```js
import { withClient } from 'electron-cdp-remote';

await withClient({ exe: 'C:/path/to/app.exe' }, async (client) => {
  const title = await client.evaluate('document.title');
  await client.evaluate('document.querySelector(".某个视图").click()');
});
```

[English](README.md) · 简体中文

---

## 常见工具为什么全都失败

发布版 Electron 应用经常在主进程里做自动化守卫。下面这种写法在实际产品里相当常见：

```js
if (app.isPackaged) {
  for (const arg of process.argv) {
    if (arg.includes('--inspect') || arg.includes('--remote-debugging-port')) {
      app.exit();
    }
  }
}
```

它拦掉了整个自动化生态赖以生存的两个参数：

| 你的尝试 | 结果 |
|---|---|
| `app.exe --remote-debugging-port=9222` | 立刻退出 |
| Playwright `_electron.launch()` | 底层是同一个参数 → 同样退出 |
| Puppeteer `connect({ browserURL: ... })` | 底层是同一个参数 → 同样退出 |
| 应用自己监听的那些端口 | 那是它自己的内部服务，不是 DevTools |

**但守卫只匹配了两个特定的字符串。** Chromium 还接受 `--remote-debugging-pipe`，它用完全相同的协议，只是把传输方式从 TCP 端口换成文件描述符 3（写）和 4（读）。这个参数通常不在黑名单里，于是应用正常启动，通道可用。

## 另外两个别用 Puppeteer 的理由

就算连上了，Puppeteer 的默认行为在这里也是隐患：

1. **它会传入 `--enable-automation`**，导致每个页面里 `navigator.webdriver === true`——一个极易被检测的自动化指纹。
2. **即使手工 `spawn` 能连上，`launch({ pipe: true })` 也实测连不上。**

本库直接讲 CDP 协议，且**只发送 `Runtime.evaluate`**，不给应用传任何自动化标记。

---

## 安装

```bash
npm install electron-cdp-remote
```

或者直接把 `src/index.mjs` 复制进你的项目——它除了 Node 标准库以外没有任何 import。

## 作为库使用

```js
import { withClient, CdpPipe } from 'electron-cdp-remote';

// 一次性：启动 → 附着 → 执行 → 清理
await withClient({
  exe: 'C:/path/to/app.exe',
  profile: 'temp',          // 'temp' | 'real' | 指定目录
  target: { urlIncludes: ['app.example.com'] },
}, async (client) => {
  console.log(await client.evaluate('document.title'));
});

// 长驻：只启动一次，之后反复操作
const client = new CdpPipe({ exe: 'C:/path/to/app.exe' });
client.launch();
await client.waitReady();
const hit = await client.attachToFirstMatching({ urlIncludes: ['app.example'] });
await client.evaluate('document.title');
client.kill();
```

### 页面交互原语

`src/page-actions.mjs` 导出若干表达式构造器，专治两个最耗时间的 DOM 坑：

```js
import { fillContentEditable, dispatchFullClick } from 'electron-cdp-remote/page-actions.mjs';

// 直接赋 innerText 只是让像素变了，框架内部状态没动，
// 于是提交按钮保持禁用，什么都发不出去。
await client.evaluate(fillContentEditable({
  selector: '.composer',
  text: 'hello',
}));
// -> { ok: true, method: 'execCommand', matches: true, submitted: false }

// 很多组件绑定在 mousedown/mouseup 上，光调 el.click() 毫无反应。
await client.evaluate(dispatchFullClick({ selector: '.submit-btn' }));
```

另有：`fillInput`、`findClickableByText`、`scrollContainer`、`probe`。

## 命令行

```bash
ecdp targets --exe /path/to/app.exe
ecdp eval    --exe /path/to/app.exe --expr "document.title"
ecdp serve   --exe /path/to/app.exe --inbox in.jsonl --outbox out.jsonl
```

`serve` 会让应用只启动一次并跨多轮复用，因此不必为每条命令都付一次冷启动——以及一次风控计数。

---

## 四个必踩的坑

下面四条每条都花了真实的时间去踩。库里都已经处理，但仍然写出来，因为你在自己的代码里还会再遇到一次。

### 1. `NODE_OPTIONS` 和 `ELECTRON_RUN_AS_NODE` 必须清掉

父进程只要设了其中之一，子进程会在几十毫秒内死掉：

| 变量 | 症状 |
|---|---|
| `NODE_OPTIONS=--require=...` | 报 `flag is not allowed in NODE_OPTIONS`，约 30ms 退出 |
| `ELECTRON_RUN_AS_NODE=1` | 二进制退化成纯 Node，报 `bad option` |

失败表现是一个干巴巴的 `Target closed`，**读起来和「调试通道也被拦了」一模一样**，非常容易让人去追错误的理论。编码助手和 IDE 终端会同时设这两个，所以在工具环境里跑比在裸 shell 里更容易踩。→ `sanitizeEnv()`

### 2. 单实例锁绑定在 user-data 目录上

`requestSingleInstanceLock()` 意味着**每个 profile 只能有一个实例**。要用已登录的 profile，必须先把正在运行的客户端彻底关掉。

更麻烦的是很多 Electron 应用是托盘常驻的：关窗口只是隐藏，进程还活着。启动前请先确认托盘宿主窗口的状态，别以为已经关干净了。→ 用 `profile: 'temp'` 可以完全绕开这一点

### 3. target 类型不一定是 `page`

Electron 应用自己的窗口常常是一个 `page`，里面再套一个 `<webview>`，而你真正关心的内容挂在 `webview` 或 `iframe` 上。附着到那个 `page`，你会得到一个空的壳，里面根本没有真正的 DOM。`listTargets()` 三种都收。→ `attachToFirstMatching()`

### 4. 单次 `evaluate` 必须远低于超时上限

把「打开面板 → 等待 → 点击 → 校验 → 输入」串进一条表达式，会**整条超时，而它的副作用其实已经生效**。此时若重试就会触发两次——如果这个动作是发消息，你已经把消息发了两遍。

正确做法是拆成多次调用，并且任何超时之后**先回读状态**再决定下一步。→ `evaluate()` 抛出的错误里就直接写明了这一点

---

## 案例：一个中国招聘类客户端

这套技术最初是为某主流招聘平台的 Windows 桌面客户端开发的——一个打包版 Electron 应用，它的 `main.js` 里正是上面引用的那段守卫，且在正式发布版里两个分支都恒为真。

值得记下来，因为这就是现实中的问题形态：

- 守卫匹配 `--inspect` 和 `--remote-debugging-port`，完全没碰 `--remote-debugging-pipe`。
- `resources/app.asar` 未加密，因此可以直接读到守卫逻辑，而不必靠猜。
- 客户端自己监听的端口是它的内部服务，不是 DevTools。
- 真正要操作的界面在 app 外壳的 `<webview>` 里，所以 target 类型必须选 `webview`。
- 输入框是 `contenteditable`，且被框架绑定，因此需要 `execCommand('insertText')`。
- 提交控件是一个 `<div>`，没有 `send` 之类的类名，只能靠可见文案定位。

本文只覆盖传输层和 DOM 机制。其中**不含**该应用的任何选择器、工作流、业务逻辑或凭据，也**不含**任何业务专属的自动化逻辑——把 `electron-cdp-remote` 指向任何一个其他带守卫的 Electron 客户端，同样的原语同样适用。

## 在不属于你的 profile 上测试

`profile: 'temp'` 会用一个一次性的 user-data 目录启动应用：未登录、不含任何会话、零账号风险。**用它来开发和验证你的选择器**，等表达式确认可用之后，再切到真实 profile——而且只对你有权自动化的软件这样做。

## 负责任地使用

- **保持人类频率。** 一个人类不可能稳定产生的那种操作量，会换来账号被封；而你依赖的这个守卫，也很可能在下一个版本就被收紧了。
- 自动化第三方应用可能违反其服务条款；绕过防自动化守卫可能触及反规避法规，具体取决于你的司法辖区。**只对你自己拥有、或已获得书面测试许可的软件使用本库。**
- 输入并提交是一个不可逆的外部动作。**在你的代码里把这两步拆开**——先填字、校验回读、再提交——这样中间始终留有一个人工或策略层的否决点。

## 许可证

MIT