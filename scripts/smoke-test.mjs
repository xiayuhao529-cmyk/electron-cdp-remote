#!/usr/bin/env node
/**
 * Smoke test. No app required — verifies that the modules parse, that the
 * public surface imports cleanly, that the profile resolver behaves, and that
 * the expression builders emit syntactically valid JavaScript.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

let passed = 0;
const queue = [];
const check = (name, fn) => { queue.push([name, fn]); };
const runAll = async () => {
  for (const [name, fn] of queue) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      console.error(`  FAIL ${name}\n       ${err.message}`);
      process.exitCode = 1;
    }
  }
};

console.log('electron-cdp-remote smoke test\n');

const mod = await import('../src/index.mjs');
const actions = await import('../src/page-actions.mjs');

check('exports the documented surface', () => {
  for (const name of ['CdpPipe', 'withClient', 'sanitizeEnv', 'resolveProfileDir', 'sleep']) {
    assert.ok(typeof mod[name] !== 'undefined', `missing export: ${name}`);
  }
});

check('sanitizeEnv strips inherited Electron traps', () => {
  process.env.NODE_OPTIONS = '--require=evil';
  process.env.ELECTRON_RUN_AS_NODE = '1';
  const env = mod.sanitizeEnv();
  assert.ok(!('NODE_OPTIONS' in env), 'NODE_OPTIONS survived');
  assert.ok(!('ELECTRON_RUN_AS_NODE' in env), 'ELECTRON_RUN_AS_NODE survived');
  delete process.env.NODE_OPTIONS;
  delete process.env.ELECTRON_RUN_AS_NODE;
});

check('sanitizeEnv keeps extra vars and the rest of the env', () => {
  const env = mod.sanitizeEnv({ CUSTOM_FLAG: '1' });
  assert.equal(env.CUSTOM_FLAG, '1');
  assert.equal(env.PATH, process.env.PATH);
});

check('resolveProfileDir temp is unique and flagged', () => {
  const a = mod.resolveProfileDir('temp');
  const b = mod.resolveProfileDir('temp');
  assert.ok(a.temp && b.temp, 'temp flag not set');
  assert.notEqual(a.dir, b.dir, 'temp dirs collided');
  assert.ok(a.dir.startsWith(os.tmpdir()), 'temp dir not under tmp');
});

check('resolveProfileDir real and explicit', () => {
  const r = mod.resolveProfileDir('real', '/custom/real');
  assert.equal(r.dir, '/custom/real');
  assert.equal(r.temp, false);
  const e = mod.resolveProfileDir('/some/where');
  assert.equal(e.dir, '/some/where');
  assert.equal(e.temp, false);
});

check('pipe framing splits on NUL, resolves the match, keeps the partial tail', () => {
  const c = new mod.CdpPipe({ exe: 'noop' });

  // Re-implement the exact read path from launch(), driven by a fake stream.
  const readStream = new EventEmitter();
  c._write = { write() {} };
  c._read = readStream;

  readStream.on('data', (chunk) => {
    c._buf += chunk.toString('utf8');
    let idx;
    while ((idx = c._buf.indexOf('\0')) !== -1) {
      const frame = c._buf.slice(0, idx);
      c._buf = c._buf.slice(idx + 1);
      if (!frame.trim()) continue;
      let msg;
      try { msg = JSON.parse(frame); } catch { continue; }
      if (msg.id && c._pending.has(msg.id)) {
        const resolve = c._pending.get(msg.id);
        c._pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  readStream.on('close', () => {
    c.closed = true;
    for (const [, resolve] of c._pending) resolve({ __closed: true });
    c._pending.clear();
  });

  const got = new Promise((resolve) => c._pending.set(7, resolve));

  // a good frame, an unrelated frame, then a truncated third
  readStream.emit('data', Buffer.from('{"id":7,"result":{"ok":true}}\0{"id":8,"result":{}}\0{"id":9,"par'));

  return got.then((msg) => {
    assert.deepEqual(msg.result, { ok: true }, 'frame did not resolve correctly');
    assert.ok(!c._pending.has(7), 'pending entry was not cleaned up');
    assert.equal(c._buf, '{"id":9,"par', 'partial trailing frame was mishandled');
  });
});

check('send rejects on a closed channel without throwing', async () => {
  const c = new mod.CdpPipe({ exe: 'noop' });
  c.closed = true;
  const res = await c.send('Browser.getVersion');
  assert.ok(res.__closed, 'expected __closed');
});

check('evaluate surfaces a JS exception as an Error', async () => {
  const c = new mod.CdpPipe({ exe: 'noop' });
  c.send = async () => ({ result: { exceptionDetails: { text: 'boom' } } });
  await assert.rejects(() => c.evaluate('1'), /JS exception/);
});

check('evaluate warns about timeout side effects', async () => {
  const c = new mod.CdpPipe({ exe: 'noop' });
  c.send = async () => ({ __timeout: true });
  await assert.rejects(() => c.evaluate('1'), /may still have taken effect/);
});

console.log('\nexpression builders');
const builders = [
  ['fillContentEditable', actions.fillContentEditable({ selector: '.x', text: 'hi' })],
  ['fillInput', actions.fillInput({ selector: '#y', text: 'hi' })],
  ['dispatchFullClick', actions.dispatchFullClick({ selector: '.z' })],
  ['findClickableByText', actions.findClickableByText({ text: 'send' })],
  ['scrollContainer', actions.scrollContainer({ selector: '.list' })],
  ['probe', actions.probe({ selector: '.el' })],
];

check('every builder returns a non-empty string', () => {
  for (const [name, expr] of builders) {
    assert.equal(typeof expr, 'string', `${name} did not return a string`);
    assert.ok(expr.length > 20, `${name} looks too short`);
  }
});

check('every builder produces syntactically valid JS', () => {
  for (const [name, expr] of builders) {
    try {
      new Function(`return ${expr}`);
    } catch (err) {
      assert.fail(`${name} emitted invalid JS: ${err.message}`);
    }
  }
});

check('selectors and text are JSON-escaped, so payloads stay inert data', () => {
  const payload = `'); globalThis.__pwned = true; ('`;
  const expr = actions.fillContentEditable({ selector: payload, text: payload });

  // Every occurrence of the payload must sit inside a double-quoted literal,
  // i.e. be preceded by a quote and followed by one. A bare occurrence
  // outside quotes would mean it was interpolated as code.
  const occurrences = expr.split(payload).length - 1;
  assert.ok(occurrences > 0, 'payload not found at all — nothing was tested');

  let idx = -1;
  let checked = 0;
  while ((idx = expr.indexOf(payload, idx + 1)) !== -1) {
    const before = expr[idx - 1];
    const after = expr[idx + payload.length];
    assert.equal(before, '"', `payload occurrence ${checked} is not preceded by a quote — interpolated as code`);
    assert.equal(after, '"', `payload occurrence ${checked} is not followed by a quote — interpolated as code`);
    checked++;
  }
  assert.equal(checked, occurrences, 'not every occurrence was checked');

  // And the whole thing must still parse.
  new Function(`return ${expr}`);
});

check('a hostile selector cannot execute when the expression runs', () => {
  const payload = '.a"), globalThis.__pwned = true, (function(){ return "';
  const expr = actions.probe({ selector: payload });

  // Run it with a stub DOM. If escaping failed, __pwned would be set here.
  const sandbox = {
    document: { querySelectorAll: () => [] },
    window: {},
  };
  const fn = new Function('document', 'window', `return (${expr});`);
  fn(sandbox.document, sandbox.window);

  assert.ok(!('__pwned' in globalThis), 'expression injection succeeded — escaping is broken');
});

console.log('\npackaging');
check('package.json has no runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.dependencies || {}, {}, 'unexpected runtime deps');
});

check('every declared bin and files path exists', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const rel of [pkg.main, ...Object.values(pkg.bin), ...(pkg.files || [])]) {
    if (rel === 'README.md' || rel === 'LICENSE') continue;
    assert.ok(fs.existsSync(path.join(root, rel)), `missing: ${rel}`);
  }
});

await runAll();

console.log(`\n${passed}/${queue.length} checks passed${process.exitCode ? ' (with failures above)' : ''}`);