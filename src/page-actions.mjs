/**
 * Page interaction primitives.
 *
 * Generic DOM mechanics for driving an Electron-rendered page. No selectors
 * for any particular app — you pass your own in as arguments.
 *
 * Two of these solve problems that are not obvious:
 *
 *  1. `fillContentEditable` — frameworks like Vue and React track input state
 *     separately from the DOM. Assigning `innerText` moves the pixels but
 *     leaves the framework's state untouched, so submit buttons stay disabled
 *     and nothing is actually sent. A synthetic `beforeinput`/`input` pair,
 *     ideally via `execCommand('insertText')`, is what the framework observes.
 *
 *  2. `dispatchFullClick` — a bare `el.click()` dispatches only a `click`
 *     event. Many components (ant-design, element-ui and friends) bind their
 *     handler to `mousedown`/`mouseup`, and only some of those check
 *     `isTrusted`. Replaying the full sequence is what a real pointer does.
 */

/**
 * Type text into a contenteditable element without submitting it.
 *
 * Selects existing contents first, so this reads as "replace what's there".
 * Read `result.readback` and `result.matches` before assuming it worked.
 */
export function fillContentEditable({ selector, text, clear = true }) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'selector matched nothing' };
    if (!el.isContentEditable && !el.getAttribute('contenteditable')) {
      return { ok: false, reason: 'target is not contenteditable' };
    }
    const txt = ${JSON.stringify(text)};
    el.focus();
    if (${clear ? 'true' : 'false'}) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    let method = 'execCommand', ok = false;
    try { ok = document.execCommand('insertText', false, txt); } catch (e) { ok = false; }
    if (!ok) { method = 'innerText'; el.innerText = txt; }
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'insertText', data: txt,
    }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const readback = (el.innerText || el.textContent || '');
    return {
      ok: true, method,
      submitted: false,
      readback: readback.slice(0, 500),
      matches: readback.trim().replace(/\\s+/g, '') === txt.replace(/\\s+/g, ''),
    };
  })()`;
}

/**
 * Type into a real <textarea> / <input> and fire the events a framework
 * listens for. Uses the native value setter so React's value tracker
 * notices the change.
 */
export function fillInput({ selector, text }) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'selector matched nothing' };
    const txt = ${JSON.stringify(text)};
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, txt);
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'insertText', data: txt,
    }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, submitted: false, matches: el.value === txt };
  })()`;
}

/**
 * Replay a full pointer sequence. Use when a bare el.click() does nothing.
 */
export function dispatchFullClick({ selector, index = 0 }) {
  return `(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = nodes[${index}];
    if (!el) return { ok: false, reason: 'selector matched nothing' };
    const opts = { bubbles: true, cancelable: true, view: window,
      clientX: 1, clientY: 1, button: 0 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, opts));
    }
    return { ok: true, tag: el.tagName,
      text: (el.innerText || el.textContent || '').trim().slice(0, 80) };
  })()`;
}

/**
 * Find a submit control by its visible text, because many UIs render the
 * button as a <div> or <span> with no class hint.
 */
export function findClickableByText({ text, tag = '*' }) {
  return `(() => {
    const re = new RegExp('^' + ${JSON.stringify(text)} + '$');
    const el = [...document.querySelectorAll(${JSON.stringify(tag)})]
      .find(e => e.children.length === 0 && re.test((e.innerText || '').trim()));
    if (!el) return { ok: false, reason: 'no clickable leaf with that exact text' };
    return { ok: true, tag: el.tagName, className: String(el.className) };
  })()`;
}

/**
 * Scroll a container to trigger lazy-loaded lists.
 * Returns the scroll metrics so you can tell whether more remains.
 */
export function scrollContainer({ selector, to = 'bottom', amount = 0 }) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'selector matched nothing' };
    const before = { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
    if (${amount} > 0) el.scrollTop = before.top + ${amount};
    else el.scrollTop = ${to === 'bottom' ? 'el.scrollHeight' : '0'};
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { ok: true, before, after: { top: el.scrollTop, height: el.scrollHeight },
      atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 4 };
  })()`;
}

/**
 * Describe an element: geometry, visibility, and which framework classes
 * it carries. Useful when a selector matches but the action does nothing.
 */
export function probe({ selector, index = 0 }) {
  return `(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}];
    if (!el) return { ok: false, reason: 'selector matched nothing' };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      ok: true,
      tag: el.tagName,
      className: String(el.className),
      text: (el.innerText || '').trim().slice(0, 200),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      visible: cs.visibility !== 'hidden' && cs.display !== 'none' &&
        parseFloat(cs.opacity) > 0.01 && r.width > 0 && r.height > 0,
      inViewport: r.bottom > 0 && r.right > 0 &&
        r.top < innerHeight && r.left < innerWidth,
      disabled: el.disabled === true ||
        el.getAttribute('aria-disabled') === 'true' ||
        cs.pointerEvents === 'none',
    };
  })()`;
}