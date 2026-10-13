/**
 * electron-cdp — drive a debug-guarded Electron desktop client over CDP.
 * Zero dependencies. Node >= 18.
 *
 * ## Why this exists
 *
 * Many shipping Electron apps guard against automation in their main process.
 * A very common pattern:
 *
 *   if (app.isPackaged) {
 *     for (const arg of process.argv) {
 *       if (arg.includes('--inspect') || arg.includes('--remote-debugging-port')) {
 *         app.exit();
 *       }
 *     }
 *   }
 *
 * That guard blocks the two flags every automation tool relies on:
 *
 *   - `--remote-debugging-port=9222`  -> instant exit
 *   - Playwright `_electron.launch()`  -> same flag underneath, same exit
 *   - Puppeteer `connect({ browserURL })` -> same flag underneath, same exit
 *
 * But the guard greps for *those two strings*. Chromium also accepts
 * `--remote-debugging-pipe`, which speaks the same DevTools Protocol over
 * fd 3 (write) / fd 4 (read) instead of a TCP port. That flag is usually
 * not on the blocklist, so the process starts normally and the channel works.
 *
 * ## What this module does and does not do
 *
 * It handles transport only: process launch, environment sanitisation, pipe
 * framing, target discovery, `Runtime.evaluate`, and a persistent session.
 * It contains no selectors and no knowledge of any particular application —
 * you pass your own expressions in.
 *
 * It deliberately does not use Puppeteer or Playwright. Besides the flag
 * problem above, those libraries set `--enable-automation`, which makes
 * `navigator.webdriver === true` in every page. That is a trivially
 * detectable automation fingerprint. This library only ever sends
 * `Runtime.evaluate`.
 *
 * ## Legal note
 *
 * Automating a third-party application may violate its terms of service,
 * and bypassing an anti-automation guard may fall under anti-circumvention
 * law depending on your jurisdiction. Only use this against software you own
 * or have written permission to test. Keep request rates human, or you will
 * trigger abuse detection and can get an account suspended.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Chromium/Electron exit within milliseconds when they inherit these from a
 * host process, and the symptom is a bare `Target closed` — which reads
 * exactly like "the debug channel was blocked". Strip them before spawn.
 *
 *   NODE_OPTIONS=--require=...   -> "flag is not allowed in NODE_OPTIONS"
 *   ELECTRON_RUN_AS_NODE=1       -> the binary degrades into plain Node
 *
 * Agent runtimes and IDE terminals set both, so this bites hardest when
 * running from a coding assistant rather than a bare shell.
 */
export function sanitizeEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * Resolve a profile strategy.
 *
 *   'temp'  -> a throwaway user-data dir, no login state, zero account risk.
 *              The right default for testing a selector for the first time.
 *   'real'  -> the real user-data dir, i.e. the logged-in session.
 *   '<path>' -> an explicit directory.
 *
 * A temp profile is deleted on close unless you pass keepTemp: true.
 */
export function resolveProfileDir(profile, realProfileDir) {
  if (profile === 'real') {
    const dir = realProfileDir || defaultRealProfileDir();
    return { dir, temp: false };
  }
  if (profile === 'temp' || !profile) {
    // Random suffix: two launches in the same millisecond must not collide,
    // or one cleanup would delete the other's profile.
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return { dir: path.join(os.tmpdir(), `electron-cdp-${unique}`), temp: true };
  }
  return { dir: profile, temp: false };
}

function defaultRealProfileDir() {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Electron'
  );
}

/**
 * Pipe-framed CDP connection.
 *
 * Wire format: UTF-8 JSON objects separated by a single NUL byte (0x00).
 * You write on fd 3, you read on fd 4. Both directions are framed the same way.
 */
export class CdpPipe {
  constructor({ exe, args = [], profileDir, env = {}, callTimeout = 10000 }) {
    this.exe = exe;
    this.extraArgs = args;
    this.profileDir = profileDir;
    this.env = env;
    this.callTimeout = callTimeout;

    this.child = null;
    this._write = null;
    this._read = null;
    this._buf = '';
    this._seq = 0;
    this._pending = new Map();
    this.sessionId = null;
    this.closed = false;
  }

  /** Spawn the app with the pipe channel attached. */
  launch() {
    const args = [
      ...(this.profileDir ? [`--user-data-dir=${this.profileDir}`] : []),
      '--remote-debugging-pipe',
      '--no-first-run',
      ...this.extraArgs,
    ];

    this.child = spawn(this.exe, args, {
      // fd0,1,2 are the defaults; fd3 write, fd4 read are the CDP pipe.
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: sanitizeEnv(this.env),
    });

    this._write = this.child.stdio[3];
    this._read = this.child.stdio[4];

    this._read.on('data', (chunk) => {
      this._buf += chunk.toString('utf8');
      let idx;
      while ((idx = this._buf.indexOf('\0')) !== -1) {
        const frame = this._buf.slice(0, idx);
        this._buf = this._buf.slice(idx + 1);
        if (!frame.trim()) continue;
        try {
          const msg = JSON.parse(frame);
          if (msg.id && this._pending.has(msg.id)) {
            const resolve = this._pending.get(msg.id);
            this._pending.delete(msg.id);
            resolve(msg);
          }
        } catch {
          // Non-JSON noise on the channel; ignore it.
        }
      }
    });

    this._read.on('close', () => {
      this.closed = true;
      for (const [, resolve] of this._pending) {
        resolve({ __closed: true });
      }
      this._pending.clear();
    });

    // Drain stderr so the child never blocks on a full pipe buffer.
    this.child.stderr.on('data', () => {});

    return this.child;
  }

  /** Send one CDP command and await its reply. */
  send(method, params = {}, sessionId = this.sessionId) {
    if (this.closed) return Promise.resolve({ __closed: true });
    const id = ++this._seq;
    const body = { id, method, params };
    if (sessionId) body.sessionId = sessionId;

    return new Promise((resolve) => {
      this._pending.set(id, resolve);
      try {
        this._write.write(JSON.stringify(body) + '\0');
      } catch (err) {
        this._pending.delete(id);
        resolve({ __error: String(err) });
        return;
      }
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          resolve({ __timeout: true });
        }
      }, this.callTimeout);
    });
  }

  /**
   * Poll until the browser answers.
   *
   * The app replies to Browser.getVersion far earlier than it finishes
   * creating page targets, so target discovery always needs its own loop.
   */
  async waitReady({ tries = 25, interval = 500 } = {}) {
    for (let i = 0; i < tries; i++) {
      await sleep(interval);
      const res = await this.send('Browser.getVersion', {}, undefined);
      if (res && res.result) return res.result;
    }
    throw new Error(
      'No CDP response within the timeout. Usual causes: a single-instance lock ' +
      'from an already-running copy, a blocked launch flag, or inherited ' +
      'NODE_OPTIONS / ELECTRON_RUN_AS_NODE.'
    );
  }

  /**
   * Poll for page targets.
   *
   * `type` matters: an Electron app's own window is often 'page' while the
   * content you actually care about lives inside a '<webview>', reported as
   * 'webview' or sometimes 'iframe'. Collect all of them, or you will attach
   * to the empty app shell and find nothing in the DOM.
   */
  async listTargets({ types = ['page', 'webview', 'iframe'] } = {}) {
    const res = await this.send('Target.getTargets', {}, undefined);
    const all = (res?.result?.targetInfos) || [];
    return {
      all: all.map((t) => ({ type: t.type, title: t.title, url: t.url, targetId: t.targetId })),
      pages: all
        .filter((t) => types.includes(t.type))
        .map((t) => ({ type: t.type, title: t.title, url: t.url, targetId: t.targetId })),
    };
  }

  async waitForTargets(predicate = () => true, { tries = 30, interval = 700 } = {}) {
    let last = { all: [], pages: [] };
    for (let i = 0; i < tries; i++) {
      last = await this.listTargets();
      const hit = last.pages.filter(predicate);
      if (hit.length) return { ...last, hit: hit[0] };
      await sleep(interval);
    }
    return { ...last, hit: null };
  }

  /**
   * Attach to a target. `flatten: true` means the session id is passed
   * per-message via `sessionId` rather than multiplexed on one connection.
   */
  async attach(targetId) {
    const res = await this.send('Target.attachToTarget', { targetId, flatten: true }, undefined);
    this.sessionId = res?.result?.sessionId || null;
    if (!this.sessionId) throw new Error('Target.attachToTarget returned no sessionId');
    return this.sessionId;
  }

  /**
   * Evaluate JS in the attached target and return a plain value.
   *
   * Keep each call well under callTimeout. A long sequence (open a panel,
   * wait, click, verify, type) chained into one expression will time out as
   * a whole *while its side effects still land* — and retrying then
   * double-fires. Split into separate calls and re-read state to confirm.
   */
  async evaluate(expression, { awaitPromise = false, userGesture = true } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture,
    });

    if (res.__timeout) throw new Error('CDP call timed out; the action may still have taken effect — verify before retrying.');
    if (res.__closed) throw new Error('CDP channel closed (app exited?)');
    if (res.__error) throw new Error('Failed to write to CDP pipe: ' + res.__error);
    if (res.error) throw new Error('CDP error: ' + JSON.stringify(res.error).slice(0, 300));

    const details = res.result?.exceptionDetails;
    if (details) throw new Error('JS exception: ' + JSON.stringify(details).slice(0, 300));

    return res.result?.result?.value;
  }

  /** Convenience: evaluate then pretty-print. */
  async evaluateJson(expression, opts) {
    return JSON.stringify(await this.evaluate(expression, opts), null, 2);
  }

  kill(signal = 'SIGTERM') {
    try { this.child?.kill(signal); } catch { /* already gone */ }
  }

  /**
   * Read targets, attach to the first match, and report what was found.
   * Throws with the full target list attached, because "no target" almost
   * always means the selector or the target-type list is wrong.
   */
  async attachToFirstMatching(matcher = {}, { tries = 30 } = {}) {
    const { include = ['page', 'webview', 'iframe'], urlIncludes = [], urlPattern = /^(https?:|file:)/, titleIncludes = [] } = matcher;

    const pred = (t) => {
      if (urlPattern && !urlPattern.test(t.url)) return false;
      if (urlIncludes.length && !urlIncludes.some((s) => t.url.includes(s))) return false;
      if (titleIncludes.length && !titleIncludes.some((s) => (t.title || '').includes(s))) return false;
      return true;
    };

    const { pages, hit } = await this.waitForTargets(pred, { tries });
    if (!hit) {
      const seen = pages.map((t) => `${t.type}\t${t.url}`).join('\n') || '(none)';
      throw new Error(`No matching target. Target types seen:\n${seen}`);
    }
    await this.attach(hit.targetId);
    return hit;
  }
}

/**
 * Launch, attach, run, and clean up in one call.
 * `target` matcher options are forwarded to attachToFirstMatching.
 */
export async function withClient({ exe, profile = 'temp', realProfileDir, args = [], env = {}, callTimeout = 10000, target, keepTemp = false }, fn) {
  const { dir, temp } = resolveProfileDir(profile, realProfileDir);
  const client = new CdpPipe({ exe, args, profileDir: dir, env, callTimeout });
  try {
    client.launch();
    const version = await client.waitReady();
    if (target !== null) {
      await client.attachToFirstMatching(target || {});
    }
    return await fn(client, version);
  } finally {
    client.kill();
    if (temp && dir && !keepTemp) {
      await sleep(800); // let the process release its lock before deleting
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}