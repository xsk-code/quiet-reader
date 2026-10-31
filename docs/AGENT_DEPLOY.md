# Agent deployment

This is the non-interactive path for an agent or a script. The service is
local-only; do not bind it to a public interface.

## Requirements

- Node.js 22+ and npm.
- A Chat Completions-compatible text endpoint (API key optional for local
  services). See [`PROVIDERS.md`](PROVIDERS.md) for examples; the app does not
  preset a provider.
- No global package, browser automation or local CLI agent is required.
- Text provider is explicit: `api`, `agy` or `codex`. There is no automatic
  fallback; set `READER_TEXT_PROVIDER` and make `doctor` report `ready: true`.

## Install and configure

```sh
git clone --depth 1 --branch v0.1.0 https://github.com/xsk-code/quiet-reader.git /opt/quiet-reader
cd /opt/quiet-reader
npm ci
export READER_DATA_DIR=/var/lib/quiet-reader
export READER_TEXT_PROVIDER=api
export READER_API_BASE_URL=https://api.example.com/v1
export READER_TEXT_MODEL=your-text-model
export READER_IMAGE_PROVIDER=none
# Inject from a secret store; never echo it or write it into the repository.
export READER_API_KEY="$(cat /run/secrets/quiet-reader-key)"
npm run doctor -- --json
```

`doctor` exits 0 when the install is healthy even if text is not configured.
Check both fields:

```json
{ "ok": true, "ready": true, "version": "0.1.0", "platform": "linux" }
```

Use `npm run doctor -- --require-model` when model configuration is part of the
acceptance gate. `--probe` sends a small paid request and is opt-in.

## Start and verify

```sh
PORT=4317 npm start
curl -fsS http://127.0.0.1:4317/api/health
```

Expected health shape:

```json
{
  "ok": true,
  "application": "shiye",
  "version": "0.1.0",
  "projectDirectory": "/opt/quiet-reader",
  "dataDirectory": "/var/lib/quiet-reader",
  "textReady": true,
  "imageReady": false,
  "textProvider": "api",
  "imageProvider": "none"
}
```

Import and poll:

```sh
curl -fsS -X POST http://127.0.0.1:4317/api/import \
  -H 'Content-Type: application/json' \
  -d '{"content":"# 标题\n\n这是一段至少三十个字符的正文，用于验证导入、翻译和阅读流程。","provider":"api","targetLanguage":"zh-CN"}'
# → 202 {"id":"...","status":"queued",...}
curl -fsS http://127.0.0.1:4317/api/jobs/<id>
# poll until status is done or error; then GET /api/articles
```

## Demo and smoke test

```sh
npm run demo                  # local mock model, sample article, opens the browser
npm run verify                # headless; temporary data; exits 0 on success
npm run --silent verify       # same, with machine-parseable JSON only
npm run demo -- --no-open
```

Neither command needs a model account or sends requests outside loopback.

## Stop and clean up

Send `SIGTERM` or `SIGINT`; the process releases the data-directory lock and
closes the listener. A second process on the same `READER_DATA_DIR` is refused.
Delete the data directory only when the user explicitly asks; it contains their
articles.

## Failure mapping

- `MODEL_NOT_CONFIGURED` (409): configure a provider.
- `IMAGE_RATE_LIMIT` (429): wait, then retry the affected images.
- `MODEL_HTTP` (502): check the endpoint, key and model; `upstreamStatus` is the
  provider status.
- `MODEL_TIMEOUT` (504): retry later or use a faster model.
- `BAD_REQUEST` (400): fix the request or input.
- `CONFLICT` (409): wait for the current job or stop the other instance.

Never print `.env` values, authorization headers or raw provider error bodies.
