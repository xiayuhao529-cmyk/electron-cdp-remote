# electron-cdp-remote


Drive a **debug-guarded Electron desktop client** over the Chrome DevTools Protocol.

No Playwright. No Puppeteer. No dependencies at all.

There is a lot of tooling for automating web pages in a browser, and almost
none for automating the **desktop client** that ships alongside them. This is
the missing piece: it attaches to a running Electron app and gives you a real
`Runtime.evaluate`, so you can read and drive the app's DOM.

```js
import { withClient } from 'electron-cdp-remote';

await withClient({ exe: 'C:/path/to/app.exe' }, async (client) => {
  const title = await client.evaluate('document.title');
  await client.evaluate('document.querySelector(".some-view").click()');
});
```

English · [简体中文](README.zh-CN.md)

---

## Why the usual tools fail

Shipping Electron apps frequently guard against automation in the main
process. A pattern that shows up in a lot of them:

```js
if (app.isPackaged) {
  for (const arg of process.argv) {
    if (arg.includes('--inspect') || arg.includes('--remote-debugging-port')) {
      app.exit();
    }
  }
}
```

That kills the two flags the entire automation ecosystem depends on:

| What you try | What happens |
|---|---|
| `app.exe --remote-debugging-port=9222` | exits immediately |
| Playwright `_electron.launch()` | same flag underneath → same exit |
| Puppeteer `connect({ browserURL: ... })` | same flag underneath → same exit |
| The app's own listening ports | its own internal service, not DevTools |

**But the guard greps for two specific strings.** Chromium also accepts
`--remote-debugging-pipe`, which speaks the identical protocol over file
descriptors 3 (write) and 4 (read) instead of a TCP port. That flag usually
isn't on the blocklist, so the app starts normally and the channel works.

## Two more reasons not to use Puppeteer here

Even when you can get a connection, Puppeteer's defaults are a liability:

1. **It sets `--enable-automation`**, so `navigator.webdriver === true` in
   every page — a trivially detectable fingerprint.
2. **`launch({ pipe: true })` does not work reliably** even where manual
   `spawn` succeeds.

This library speaks CDP directly and only ever sends `Runtime.evaluate`. No
automation flags are passed to the app.

---

## Install

```bash
npm install electron-cdp-remote
```

Or copy `src/index.mjs` into your project — it has zero imports beyond Node's
standard library.

## Library

```js
import { withClient, CdpPipe } from 'electron-cdp-remote';

// one-shot: launch, attach, run, clean up
await withClient({
  exe: 'C:/path/to/app.exe',
  profile: 'temp',          // 'temp' | 'real' | an explicit dir
  target: { urlIncludes: ['app.example.com'] },
}, async (client) => {
  console.log(await client.evaluate('document.title'));
});

// long-lived: launch once, drive many times
const client = new CdpPipe({ exe: 'C:/path/to/app.exe' });
client.launch();
await client.waitReady();
const hit = await client.attachToFirstMatching({ urlIncludes: ['app.example'] });
await client.evaluate('document.title');
client.kill();
```

### Page interaction primitives

`src/page-actions.mjs` exports expression builders that solve the two DOM
problems that cost the most time to rediscover:

```js
import { fillContentEditable, dispatchFullClick } from 'electron-cdp-remote/page-actions.mjs';

// A bare innerText assignment moves pixels but leaves framework state
// untouched, so submit buttons stay disabled and nothing gets sent.
await client.evaluate(fillContentEditable({
  selector: '.composer',
  text: 'hello',
}));
// -> { ok: true, method: 'execCommand', matches: true, submitted: false }

// Many components bind to mousedown/mouseup; el.click() alone does nothing.
await client.evaluate(dispatchFullClick({ selector: '.submit-btn' }));
```

Also available: `fillInput`, `findClickableByText`, `scrollContainer`, `probe`.

## CLI

```bash
ecdp targets --exe /path/to/app.exe
ecdp eval    --exe /path/to/app.exe --expr "document.title"
ecdp serve   --exe /path/to/app.exe --inbox in.jsonl --outbox out.jsonl
```

`serve` keeps one app instance alive across many rounds, so you are not paying
a cold start — and an anti-abuse threshold — on every command.

---

## The traps

These are the four that cost real hours. All are handled in the library, and
documented because you will hit them again in your own code.

### 1. `NODE_OPTIONS` and `ELECTRON_RUN_AS_NODE` must be stripped

If the parent process sets either one, the child dies within milliseconds:

| Variable | Symptom |
|---|---|
| `NODE_OPTIONS=--require=...` | `flag is not allowed in NODE_OPTIONS`, exit in ~30ms |
| `ELECTRON_RUN_AS_NODE=1` | the binary degrades into plain Node, `bad option` |

The failure mode is a bare `Target closed`, which reads *exactly* like "the
debug channel was blocked too". Easy to spend hours chasing the wrong theory.
Coding assistants and IDE terminals set both, so this bites hardest when
running from a tool rather than a bare shell. → `sanitizeEnv()`

### 2. The single-instance lock is bound to the user-data dir

`requestSingleInstanceLock()` means **only one copy per profile**. Using a
logged-in profile requires the running app to be fully closed first.

Worse, many Electron apps are tray-resident: closing the window only hides it
and the process lives on. Check for a tray host window before assuming you are
safe to launch. → use `profile: 'temp'` to sidestep entirely

### 3. Target type is not always `page`

An Electron app's own window is often a `page` containing a `<webview>`, and
the content you care about is reported as `webview` or `iframe`. Attach to the
`page` and you will find an empty app shell with none of the real DOM in it.
`listTargets()` collects all three. → `attachToFirstMatching()`

### 4. One `evaluate` must stay well under the call timeout

Chaining "open panel → wait → click → verify → type" into a single expression
will time out **as a whole while its side effects still land**. Retrying then
double-fires — and if the action sends a message, you have now sent it twice.

Split into separate calls, and after any timeout **re-read state** before
deciding what to do. → `evaluate()` throws a warning that says exactly this

---

## Case study: a Chinese recruitment client

The technique was developed against the Windows desktop client of a major
Chinese job marketplace — a packaged Electron app whose `main.js` contains
precisely the guard quoted above, with both branches true in the shipped build.

Worth recording, because it is the shape of the problem in the wild:

- The guard reads `--inspect` and `--remote-debugging-port`; `--remote-debugging-pipe` is untouched.
- `resources/app.asar` is not encrypted, so the guard can be read directly instead of guessed at.
- The client's own listening ports are its internal service, not DevTools.
- The interesting UI lives in a `<webview>` inside the app shell, so target type `webview` is required.
- The composer is `contenteditable` — framework-bound, so it needs `execCommand('insertText')`.
- The submit control is a `<div>`, has no `send`-like class name, and is found only by its label text.

This write-up covers the transport and the DOM mechanics. It contains none of
that application's selectors, workflow, business logic, or credentials, and
none of the automation is app-specific — if you point `electron-cdp-remote`
at any other guarded Electron client, the same primitives apply.

## Testing on a profile you do not own

`profile: 'temp'` launches with a throwaway user-data directory: not logged
in, holding no sessions, no account at risk. Use it to develop and verify your
selectors. Only switch to a real profile once the expressions are known-good,
and only against software you are authorised to automate.

## Responsible use

- Keep request rates human. Volume that no person could generate reliably gets
  an account suspended, and the guard you are relying on may well get
  tightened in the next release.
- Automating a third-party application may violate its terms of service, and
  bypassing an anti-automation guard may fall under anti-circumvention law
  depending on your jurisdiction. Only use this against software you own or
  have written permission to test.
- Type-and-submit is an irreversible external action. Keep the two steps
  separate in your code — fill, verify the readback, then submit — so a human
  or a policy layer gets a veto point in between.

## License

MIT
