# Worked example

A complete integration against a **guarded Electron desktop client**, written
the way you should structure a real one:

1. Launch on a throwaway profile — never develop selectors against a live account.
2. Attach to the correct target type, and notice if you got the app shell
   instead of the webview.
3. Read the list, scrolling to defeat lazy-loading.
4. **Type without submitting, and read the value back.** A composer that looks
   filled but holds nothing is the single most common silent failure.
5. Submit only behind an explicit flag, and only after the draft verified.

```bash
node example.mjs --exe "C:/path/to/app.exe"
node example.mjs --exe "C:/path/to/app.exe" --submit
```

All selectors live in the `SEL` object at the top. They are placeholders —
supply your own.

## Why it is shaped this way

- **One round trip per action.** Each CDP call stays far below the call
  timeout. Chaining steps into one expression risks a timeout whose side
  effects still land, and a retry then fires the action twice.
- **Verify after writing.** `fillContentEditable` returns a readback and a
  `matches` flag; the example refuses to continue unless it passed.
- **Submit is a separate, gated step.** Type and submit are never the same
  operation, so a policy layer or a human gets a veto point between them.
- **The draft is ephemeral.** It exists in the DOM and nowhere else. When the
  process exits, it is gone.