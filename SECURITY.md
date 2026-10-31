# Security

## Supported versions

Security fixes target the latest `0.x` release. There is no long-term support
branch yet.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting (Security → Advisories → Report a
vulnerability). Do not open a public issue containing credentials, private
articles, provider error bodies or a working exploit. If private reporting is
unavailable, open a minimal issue asking for a private channel; do not include
the sensitive details.

Please include the affected version, platform, reproduction steps and impact.
Never send a real API key or private article content.

## Threat model

Quiet Reader is a single-user local service. It binds `127.0.0.1` by default and
has no login, multi-user isolation or public-hosting mode. Do not expose it to a
LAN or the internet, and do not put it behind a reverse proxy without adding
authentication and transport security.

- **Article content is untrusted.** HTML is sanitized, outbound article fetches
  are restricted to public HTTP/HTTPS addresses, and model output is treated as
  data. Do not add code paths that execute article HTML, Markdown, SVG or model
  instructions.
- **Model output is untrusted.** The SVG renderer accepts a fixed element set,
  numbers, colors and escaped text. Keep drawing validation separate from model
  calls.
- **API keys** can come from `READER_API_KEY` / `READER_IMAGE_API_KEY`, an ignored
  `.env`, or the local setup page. Page keys are written to `data/secrets.json`
  with mode 0600, are never returned to the browser, and are not stored in
  `settings.json` or localStorage. Environment variables take priority. A
  distinct image endpoint never inherits the text key. The local secrets file is
  plaintext, like `.env`; protect the data directory and backups.
- **Local data** in `READER_DATA_DIR` is not encrypted. It can contain private
  articles, translations and images. Protect the directory and back it up
  accordingly.
- **No telemetry.** The only outbound requests are article fetches, image
  downloads, requests to the model endpoint the user configured and, for X links
  that only render behind a login, one request per import to the FxTwitter API
  (`READER_X_API`; set `off` to disable). That service sees the post path being
  imported; no X account or cookie is used.
- **Browser extension.** The optional Chrome/Edge extension gets a temporary
  `activeTab` grant only when the user invokes it, and sends only the current
  page URL (or a right-clicked link URL) to `POST /api/import`. It has no content
  script and does not read page text, cookies or storage. The server accepts
  `chrome-extension://` origins only for that route; other extensions on the
  machine can therefore queue an import, but cannot read articles, setup or
  credentials. Article fetching still follows the public-address rules, and
  login walls are not bypassed.

## Scope

In scope: the local server, provider adapters, article extraction, image
pipeline, SVG rendering, configuration and data handling.

Out of scope: vulnerabilities in third-party model providers, websites being
read, the user's operating system, and attacks that require an already
compromised local account.
