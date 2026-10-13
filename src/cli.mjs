#!/usr/bin/env node
/**
 * ecdp — command line front end for electron-cdp.
 *
 * Every command is application-agnostic: you supply the executable, the
 * profile, and the expression. Nothing about any particular app is baked in.
 *
 *   ecdp targets  --exe <path> [--profile temp|real|<dir>]
 *   ecdp eval     --exe <path> --expr "document.title"
 *   ecdp serve    --exe <path> --inbox in.jsonl --outbox out.jsonl
 *
 * Options
 *   --exe <path>        executable to launch                  (required)
 *   --profile <s>       temp | real | <dir>                   (default: temp)
 *   --real-profile <d>  the real user-data dir, for --profile real
 *   --target-url <s>    attach to the first target whose URL contains this
 *   --call-timeout <ms> per-CDP-call timeout                  (default: 10000)
 *   --keep-open         leave the app running after the command
 *   --keep-temp         do not delete the temp profile
 *   --delay <ms>        sleep after attaching, before evaluating
 */

import { CdpPipe, resolveProfileDir, sleep } from './index.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];

function opt(name, fallback = undefined) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const EXE = opt('exe');
const PROFILE = opt('profile', 'temp');
const TARGET_URL = typeof opt('target-url') === 'string' ? opt('target-url') : '';
const CALL_TIMEOUT = parseInt(opt('call-timeout', '10000'), 10);
const KEEP_OPEN = !!opt('keep-open', false);
const KEEP_TEMP = !!opt('keep-temp', false);
const DELAY = parseInt(opt('delay', '0'), 10);
const log = (s) => console.log(s);

if (!cmd || cmd === 'help' || cmd === '--help') {
  log(`ecdp — drive a debug-guarded Electron client over CDP

  ecdp targets --exe <path>
  ecdp eval    --exe <path> --expr "document.title"
  ecdp serve   --exe <path> --inbox in.jsonl --outbox out.jsonl [--idle-timeout 600]

  --profile temp|real|<dir>   default: temp (throwaway, not logged in)
  --real-profile <dir>        required for --profile real
  --target-url <substring>    which target to attach to
  --call-timeout <ms>         default: 10000
  --keep-open                 leave the app running afterwards
  --keep-temp                 keep the temp profile directory`);
  process.exit(cmd ? 0 : 1);
}

if (!EXE || typeof EXE !== 'string') {
  console.error('[error] --exe <path to executable> is required');
  process.exit(1);
}

const { dir: profileDir, temp } = resolveProfileDir(
  PROFILE,
  typeof opt('real-profile') === 'string' ? opt('real-profile') : undefined
);

const client = new CdpPipe({
  exe: EXE,
  profileDir,
  callTimeout: CALL_TIMEOUT,
});

let exitCode = 0;

try {
  log(`[profile] ${PROFILE} -> ${profileDir}${temp ? '  (temporary, not logged in)' : '  (existing profile)'}`);
  client.launch();

  const version = await client.waitReady();
  log(`[cdp] connected: ${version.product}`);

  if (cmd !== 'targets') {
    const hit = await client.attachToFirstMatching({
      urlIncludes: TARGET_URL ? [TARGET_URL] : [],
    });
    log(`[cdp] attached to ${hit.type} ${hit.url.slice(0, 160)}`);
    if (DELAY) await sleep(DELAY);
  }

  if (cmd === 'targets') {
    const { pages, all } = await client.listTargets();
    log('\ntargets:');
    for (const t of all) log(`  [${t.type}] ${t.title || '(no title)'}\n         ${t.url}`);
    if (!pages.length) log('\n  (no page/webview/iframe targets yet — the app may still be booting)');
  } else if (cmd === 'eval') {
    const expr = opt('expr');
    if (typeof expr !== 'string') throw new Error('--expr <javascript> is required');
    log(await client.evaluateJson(expr, { awaitPromise: true }));
  } else if (cmd === 'serve') {
    await serveLoop();
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
} catch (err) {
  console.error('\n[error]', err?.message || err);
  exitCode = 1;
} finally {
  if (!KEEP_OPEN) {
    client.kill();
    if (temp && !KEEP_TEMP) {
      await sleep(1000);
      try {
        const fs = await import('node:fs');
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
    process.exit(exitCode);
  } else {
    log(`\n[keep-open] app left running, pid=${client.child?.pid}`);
    process.exit(exitCode);
  }
}

/**
 * Persistent session: the app is launched once and driven over many rounds
 * via two files, so you are not paying a cold start (and an anti-abuse
 * threshold) per command.
 *
 *   inbox  one JSON object per line
 *   outbox one JSON object per line, correlated by id
 *
 * {"id":1,"cmd":"eval","expr":"document.title"}
 * {"id":2,"cmd":"quit"}
 *
 * Note: the idle timeout kills the app on exit. Anything typed but not
 * submitted is lost with it. Either raise --idle-timeout, keep the app alive
 * with a harmless no-op op, or finish a type-and-submit sequence in one round.
 */
async function serveLoop() {
  const fs = await import('node:fs');
  const inbox = opt('inbox');
  const outbox = opt('outbox');
  const idle = parseInt(opt('idle-timeout', '600'), 10);

  if (typeof inbox !== 'string' || typeof outbox !== 'string') {
    throw new Error('serve requires --inbox <path> and --outbox <path>');
  }

  fs.writeFileSync(inbox, '');
  fs.writeFileSync(outbox, '');
  const emit = (obj) => fs.appendFileSync(outbox, JSON.stringify(obj) + '\n');

  log(`[serve] ready. inbox=${inbox} outbox=${outbox} idle=${idle}s`);
  let offset = 0;
  let lastAct = Date.now();

  for (;;) {
    await sleep(500);

    let text = '';
    try { text = fs.readFileSync(inbox, 'utf8'); } catch { continue; }

    if (text.length > offset) {
      const chunk = text.slice(offset);
      offset = text.length;

      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lastAct = Date.now();

        let op;
        try {
          op = JSON.parse(trimmed);
        } catch {
          emit({ ok: false, error: 'malformed JSON line' });
          continue;
        }

        if (op.cmd === 'quit') {
          emit({ id: op.id, ok: true, quit: true });
          return;
        }

        try {
          if (op.cmd === 'eval') {
            emit({ id: op.id, ok: true, data: { value: await client.evaluate(op.expr, { awaitPromise: true }) } });
          } else if (op.cmd === 'targets') {
            const { all } = await client.listTargets();
            emit({ id: op.id, ok: true, data: { targets: all } });
          } else {
            emit({ id: op.id, ok: false, error: `unknown command: ${op.cmd}` });
          }
        } catch (err) {
          emit({ id: op.id, ok: false, error: String(err?.message || err).slice(0, 500) });
        }
      }
    }

    if ((Date.now() - lastAct) / 1000 > idle) {
      log('[serve] idle timeout reached, exiting');
      return;
    }
  }
}