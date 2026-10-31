# Provider recipes

These are **examples, not defaults**. The app does not hardcode a provider or
prefer agy/Codex over an API. Fill the base URL and model from your provider's
console; the app appends `/chat/completions`, so do not include that suffix.

Enter the key in the local setup page (stored in `data/secrets.json`, 0600, not
returned to the browser) or inject it from an environment variable/secret
manager. Never put a key in a URL, a screenshot or a commit.

## Common recipes

| Provider | `READER_API_BASE_URL` example | Text model example | Vision | Key |
| --- | --- | --- | --- | --- |
| Ollama (local) | `http://127.0.0.1:11434/v1` | model pulled locally, e.g. `qwen2.5:7b` | depends on model | none |
| LM Studio (local) | `http://127.0.0.1:1234/v1` | model name shown by the server | depends on model | none |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | no | `READER_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | model slug from the catalog | depends on model | `READER_API_KEY` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | model from the console | depends on model | `READER_API_KEY` |
| OpenAI-compatible gateway | your gateway `/v1` | model from the gateway | depends on model | `READER_API_KEY` |

Model names and endpoints change. Treat the table as a starting point and check
the provider's current documentation. The setup page can read `GET /models` to
suggest model IDs; if the provider lacks that endpoint, type the model manually. A provider that implements
`POST /chat/completions` is not automatically compatible with every model or
image format.

## DeepSeek example

```dotenv
READER_TEXT_PROVIDER=api
READER_API_BASE_URL=https://api.deepseek.com/v1
READER_TEXT_MODEL=deepseek-chat
READER_IMAGE_PROVIDER=none
READER_API_KEY=在本机填写，不要提交或粘贴到聊天
```

Then restart the service and verify the actual login/model permission:

```sh
npm run doctor -- --json --require-model
npm run doctor -- --probe          # sends a small request and may cost
```

If the base URL already contains `/v1`, do not add `/chat/completions`; the app
adds it. If your provider gives a different base path, use that exact prefix.

## Local models

Ollama and LM Studio are useful when the article text must stay on the machine.
Text and image providers are independent:

```dotenv
READER_TEXT_PROVIDER=api
READER_API_BASE_URL=http://127.0.0.1:11434/v1
READER_TEXT_MODEL=qwen2.5:7b
READER_IMAGE_PROVIDER=none
```

If the local model cannot see images, keep `READER_IMAGE_PROVIDER=none`; the
original pictures remain readable. Do not point the image provider at a service
that did not explicitly accept images.

## Selecting a provider

- The setup page configures API only. The text provider is still explicit:
  `api`, `agy` or `codex`; agy/Codex are configured through environment
  variables, not the page. There is no automatic fallback.
- Choose `api` for a server or CI deployment; fill the base URL and model.
- Choose `agy` or `Codex` only when that CLI is installed, logged in and allowed
  to run. Windows `.cmd`/`.bat` shims are not supported.
- Image selection is independent: `api`, `agy` or `none`. The default is `api`
  with the text model, which assumes a multimodal model; choose `none` for a
  text-only endpoint.
- The API path and the local CLI path are independent; do not assume one tests
  the other.

Record verified endpoints in [`COMPATIBILITY.md`](COMPATIBILITY.md). Do not add a
provider to a supported list based only on a successful `/models` request.
