# Provider compatibility

This file records real endpoints that maintainers have exercised. It is not a
claim that every OpenAI-compatible service works. Fill it only with results you
actually observed; do not include keys, account names or private article text.

The app does not preset agy, Codex or any API vendor. The rows below document
what was tested, not defaults; configure the provider that fits the deployment.

## Text

| Provider | Endpoint prefix | Model | Date | Result | Notes |
| --- | --- | --- | --- | --- | --- |
| agy (Antigravity CLI) | local CLI | `gemini-3.8-flash-low` | 2026-10-30 | pass | probe + full translation of `examples/sample.md`; 456-char output; no rate-limit stress |
| OpenAI-compatible API (CommandCode gateway) | `https://api.commandcode.ai/provider/v1` | `deepseek/deepseek-v4.1-flash` | 2026-10-31 | pass | probe + full translation of `examples/sample.md` to `en`; headings, list, table kept, code block unchanged; no rate-limit stress |

## Vision

| Provider | Endpoint prefix | Model | Date | Result | Notes |
| --- | --- | --- | --- | --- | --- |
| OpenAI-compatible API (CommandCode gateway) | `https://api.commandcode.ai/provider/v1` | `deepseek/deepseek-v4.1-flash` (text model reused) | 2026-10-31 | probe only | `doctor --probe` image connection passed; no real picture redraw exercised |
| agy (Antigravity CLI) | local CLI | `gemini-3.8-flash-high` | 2026-10-30 | pass | probe + public `httpbin.org/image/png`; model returned `skipped` for the photo, so download/recognition/skip passed; scene redraw not exercised |

## Live coverage

- 2026-10-30: `npm run doctor -- --probe` passed text and image probes via `agy`.
- 2026-10-30: one full text translation and one image pipeline run passed on
  macOS with `IMAGE_CONCURRENCY=1`.
- 2026-10-31: `npm run doctor -- --probe` passed text and image probes through an
  OpenAI-compatible API key; one full text translation passed on macOS.
- Not yet exercised with a real service: API image redraw, two-image concurrency
  and provider 429. These remain manual release checks.

## Manual checks

For each provider, verify:

1. Text translation of `examples/sample.md`.
2. One image redraw with `IMAGE_CONCURRENCY=1`, then `2`.
3. A wrong key returns `MODEL_HTTP` 502 with `upstreamStatus` 401/403 and no key
   in the response.
4. A 429 pauses the image queue; after quota recovers, the failed image retries.
5. A model without vision returns `imageReady: false` or degrades to the
   original image without blocking text.

Local agents `agy` and Codex depend on the installed CLI and account. Windows
`.cmd`/`.bat` shims are not supported.
