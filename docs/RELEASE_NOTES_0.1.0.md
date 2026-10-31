# Quiet Reader v0.1.0

The first public release of a local-first article translator and reader.

## Highlights

- Import a URL or Markdown, translate whole articles into the language you pick
  (10 languages; defaults to the browser language), and read in translated,
  original or side-by-side mode.
- Long articles are saved chunk by chunk. Timeouts, connection errors, 429 and
  5xx are retried; a failed run resumes from the first unfinished chunk.
- Pages that block the reader explain why and offer "open original" and
  "paste"; X posts behind a login are read through the public FxTwitter API
  (`READER_X_API` to self-host or `off`).
- Use any Chat Completions-compatible endpoint you configure; no provider is
  preset. Text provider selection is explicit (`api` / `agy` / `codex`), and
  import stays disabled until at least one provider is usable. Local agy/Codex adapters remain
  optional and are configured through environment variables, not the setup
  page. Image settings are collapsed and default to the same multimodal model.
  The setup page can read `/models` for suggestions, with manual entry as a
  fallback. Import shows an API/agy/Codex choice when several providers are
  usable.
- Optional figure redraw: the vision model returns a constrained layout and the
  local renderer produces an SVG. Photos and unreliable figures keep the
  original, and the original is always one click away.
- Local library, reading progress, favorites, search and Markdown export.
- Optional Chrome/Edge extension: one click on an article (or a right-clicked
  link) sends only its URL to the local service and opens the reading page. Load
  `extension/` unpacked or build a distributable zip with
  `npm run extension:zip`; see [`docs/EXTENSION.md`](EXTENSION.md).
- Text and image API keys can be entered in the local setup page. They are
  write-only, stored in `data/secrets.json` (0600), and never returned to the
  browser; environment variables take priority.
- Bounded image concurrency, recognition cache, replay, per-image retry and
  local timings.
- No account, telemetry or tracking. The service binds `127.0.0.1`.

## Install

Requires Node.js 22+ and npm.

```sh
git clone https://github.com/xsk-code/quiet-reader.git
cd quiet-reader
npm ci
npm start
```

Open <http://127.0.0.1:4317>. For one-click import, load the `extension/` folder
from this checkout in Chrome/Edge 103+ while the service is running. The
extension has no content script and does not read page text, cookies or the
logged-in session; see [`docs/EXTENSION.md`](EXTENSION.md).

To preview without credentials:

```sh
npm run demo
```

To verify the install headlessly:

```sh
npm run verify
npm run doctor -- --json
```

Provider examples are in [`docs/PROVIDERS.md`](PROVIDERS.md). Model names and
base URLs are examples, not defaults; check your provider's console.

## Verification

- The 130-test suite covers the server, UI, extension and packaging on macOS,
  Linux and Windows.
- CI covers Node.js 22 and 24 on the three platforms.
- `npm run verify` and `doctor --require-model` are part of the CI gate.
- The extension zip is deterministic and covered by tests; `npm run extension:zip`
  prints its SHA-256.
- A live text translation and a live image pipeline were exercised with `agy`.
- The API path was exercised with an OpenAI-compatible gateway serving a DeepSeek
  model: text and vision probes plus a full translation of `examples/sample.md`;
  see [`docs/COMPATIBILITY.md`](COMPATIBILITY.md).

## Known limitations

- Windows supports API-only mode. Local `.cmd`/`.bat` agents are not supported.
- Not every OpenAI-compatible service or model works. Protocol compatibility is
  not a guarantee; use `doctor --probe` and record results.
- Image redraw is best-effort. It preserves the original and does not promise
  pixel-perfect output.
- No public hosting, multi-user authentication or container deployment in this
  release.
- The one-click extension requires Chrome/Edge 103+ and the default
  `127.0.0.1:4317` address; Safari/Firefox users can paste content. It does not
  bypass login walls or paywalls.
- LaTeX and Mermaid are not rendered; Markdown editing is not live.
- Real provider 429 behavior and multi-image throughput still need manual
  acceptance with the relevant account.

## License

Project code is MIT. PT Serif is SIL OFL 1.1; dependencies retain their own
licenses. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
