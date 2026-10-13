#!/usr/bin/env node
/**
 * Worked example: attaching to a guarded recruitment client.
 *
 * This file shows the *shape* of an integration — launch on a throwaway
 * profile, wait for the webview target, read a list, fill a composer without
 * submitting, then submit only behind an explicit confirmation flag.
 *
 * Every selector here is a placeholder. Substitute your own; nothing about
 * any particular application is assumed or hardcoded.
 *
 *   node example.mjs --exe "C:/path/to/app.exe"
 *   node example.mjs --exe "C:/path/to/app.exe" --submit   (still a dry run)
 */

import { CdpPipe, resolveProfileDir, sleep } from '../../src/index.mjs';
import {
  fillContentEditable,
  dispatchFullClick,
  findClickableByText,
  scrollContainer,
  probe,
} from '../../src/page-actions.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const EXE = opt('exe');
const SUBMIT = !!opt('submit', false);

// ---------- placeholders: replace with your own selectors ----------
const SEL = {
  // The list container is usually the element that scrolls and lazy-loads.
  list: '.conversation-list',
  // One row within it.
  row: '.conversation-item',
  rowTitle: '.item-title',
  rowPreview: '.item-preview',
  // Often absent until a row is selected — that absence is normal.
  composer: '.composer-input[contenteditable="true"]',
  submit: '.composer-actions .submit',
};

// ------------------------------------------------------------------------

if (typeof EXE !== 'string') {
  console.error('usage: node example.mjs --exe <path to executable> [--submit]');
  process.exit(1);
}

/** Read the conversation list, scrolling until it stops growing. */
async function readList(client, limit = 30) {
  const seen = new Map();

  for (let round = 0; round < 10; round++) {
    const batch = await client.evaluate(`(() => {
      const rows = [...document.querySelectorAll(${JSON.stringify(SEL.row)})];
      return rows.map(el => {
        const text = (sel) => {
          const e = el.querySelector(sel);
          return e ? (e.innerText || '').trim() : '';
        };
        return {
          id: el.getAttribute('data-id') || null,
          title: text(${JSON.stringify(SEL.rowTitle)}),
          preview: text(${JSON.stringify(SEL.rowPreview)}).slice(0, 120),
        };
      }).filter(x => x.title);
    })()`);

    if (!Array.isArray(batch)) break;
    const before = seen.size;
    for (const item of batch) seen.set(item.id || item.title, item);

    // Stop when a scroll pass yields nothing new.
    const scrolled = await client.evaluate(scrollContainer({ selector: SEL.list, to: 'bottom' }));
    if (!scrolled?.ok) break;
    await sleep(1200);
    if (seen.size === before) break;
    if (seen.size >= limit) break;
  }

  return [...seen.values()].slice(0, limit);
}

/** Select a row by its visible title. */
async function openRow(client, title) {
  const clicked = await client.evaluate(`(() => {
    const rows = [...document.querySelectorAll(${JSON.stringify(SEL.row)})];
    const hit = rows.find(el => {
      const t = el.querySelector(${JSON.stringify(SEL.rowTitle)});
      return t && (t.innerText || '').trim() === ${JSON.stringify(title)};
    });
    if (!hit) return { ok: false, reason: 'row not in the rendered window' };
    hit.click();
    return { ok: true, id: hit.getAttribute('data-id') };
  })()`);

  if (!clicked?.ok) return clicked;
  await sleep(1500);
  return clicked;
}

/**
 * Type into the composer and verify it landed — without submitting.
 * The readback is the point: a silent no-op here would otherwise look like
 * a successful draft until you went looking for it later.
 */
async function compose(client, text) {
  const exists = await client.evaluate(probe({ selector: SEL.composer }));
  if (!exists?.ok) {
    return { ok: false, stage: 'probe', detail: exists };
  }
  if (!exists.inViewport) {
    console.log('   composer is off-screen; scroll it into view first');
  }

  const filled = await client.evaluate(fillContentEditable({
    selector: SEL.composer,
    text,
  }));

  if (!filled?.ok || !filled?.matches) {
    return { ok: false, stage: 'fill', detail: filled };
  }
  return { ok: true, submitted: false, method: filled.method };
}

async function submit(client) {
  // Confirm the control is real and clickable before touching it.
  const check = await client.evaluate(probe({ selector: SEL.submit }));
  if (!check?.ok || !check?.visible) {
    return { ok: false, reason: 'submit control missing or not visible', detail: check };
  }

  const label = await client.evaluate(findClickableByText({ text: '发送' }));
  if (!label?.ok) {
    return { ok: false, reason: 'no submit control with the expected label', detail: label };
  }

  const clicked = await client.evaluate(dispatchFullClick({ selector: SEL.submit }));
  await sleep(2000);
  return { ok: !!clicked?.ok, submitted: true, detail: clicked };
}

// ------------------------------------------------------------------------

const { dir: profileDir, temp } = resolveProfileDir('temp');
const client = new CdpPipe({ exe: EXE, profileDir });

try {
  console.log(`[1/5] launching on a throwaway profile (not logged in, zero account risk)\n     ${profileDir}`);
  client.launch();

  console.log('[2/5] waiting for the CDP channel');
  const version = await client.waitReady();
  console.log(`     connected: ${version.product}`);

  console.log('[3/5] finding the target — try "page" first, then "webview"/"iframe"');
  const hit = await client.attachToFirstMatching({});
  console.log(`     attached to [${hit.type}] ${hit.url.slice(0, 100)}`);
  if (hit.type === 'page') {
    console.log('     note: if the DOM looks empty, re-attach to the webview target instead');
  }

  console.log('[4/5] reading the list');
  const list = await readList(client);
  console.log(`     found ${list.length} rows`);
  for (const [i, row] of list.entries()) {
    console.log(`     ${String(i + 1).padStart(3)}. ${row.title}   ${row.preview}`);
  }

  console.log('[5/5] composing a message — type only, nothing is sent');
  if (list.length === 0) {
    console.log('     no rows to work with; adjust the selectors and retry');
  } else {
    const opened = await openRow(client, list[0].title);
    console.log(`     opened: ${JSON.stringify(opened)}`);

    const draft = await compose(client, '这是一段示例文本，仅填入不发送。');
    console.log(`     draft:  ${JSON.stringify(draft)}`);

    if (SUBMIT) {
      const sent = await submit(client);
      console.log(`     submit: ${JSON.stringify(sent)}`);
    } else {
      console.log('     submit: skipped (pass --submit to attempt it)');
      console.log('     note:   the draft dies with the process — it is never stored');
    }
  }
} catch (err) {
  console.error('\n[error]', err?.message || err);
  process.exitCode = 1;
} finally {
  client.kill();
  if (temp) {
    await sleep(1000);
    const fs = await import('node:fs');
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.exit(process.exitCode || 0);
}