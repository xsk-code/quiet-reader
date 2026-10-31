# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
semantic versioning while staying in the `0.x` range.

## [0.1.0] - 2026-10-31

### Added

- 目标语言：导入栏「译为」可选 10 种语言，默认跟随浏览器语言并记在本机；
  `READER_TARGET_LANGUAGE` 设置服务端默认值，`/api/import` 与重译接口接受
  `targetLanguage`。图片按目标语言重绘，缓存与本地重放按语言区分。
- 长文续翻：每段译完即保存到 `translationDraft`；超时、断连、429 和 5xx 自动
  重试两次，仍失败时重试从第一个未完成的段落继续，服务重启后同样可续。
- X 帖子与长文：遇到登录墙时经公开的 FxTwitter 接口读取（`READER_X_API` 可自建，
  `off` 关闭），不使用账号；已登录渲染的 X Article 直接提取正文。
- 导入栏「粘贴」一键读取剪贴板；抓取失败提示中提供「打开原文」「粘贴正文」。
- 阅读页右上角 ⛶ 改为全屏阅读：只保留正文，Esc 或「退出全屏」返回，浏览器
  不支持时退化为专注布局。
- Chrome/Edge 一键导入插件（`extension/`）：在任意网页点扩展图标或右键链接，
  只把当前网址交给本机 `/api/import`，随后打开或复用阅读页并跟踪任务；
  服务不可达时退回 `/?pending=<url>` 预填，确认后才开始翻译。插件不读取正文、
  Cookie 或登录态；服务端仅对 `chrome-extension://` 来源开放导入接口。
- 扩展打包：`npm run extension:zip` 生成只含 `manifest.json`、service worker、
  `lib.mjs` 和图标的确定性 zip，输出 SHA-256，便于本地分发或商店上传。
- Local article translation and reading: URL or Markdown import, translated /
  original / bilingual modes, outline, focus mode, themes and reading progress.
- Any OpenAI-compatible Chat Completions endpoint, optional local `agy` / Codex
  adapters, and a separate optional vision endpoint.
- Image redraw: structured recognition, validated local SVG, original-image
  toggle, global concurrency pool, cache, replay and per-image retry.
- `npm run demo` (no credentials) and `npm run verify` (headless install smoke).
- `GET /api/health`, stable API error codes and documented HTTP status mapping.
- Windows API-only job in CI; local `.cmd`/`.bat` agents remain unsupported.
- Local setup page accepts write-only text/image API keys, stored in
  `data/secrets.json` (0600); environment variables win.
- The setup page can fetch model IDs from the provider's `/models` endpoint and
  offers them as suggestions; manual entry remains available.
- Single-instance data-directory lock and SIGINT/SIGTERM shutdown.

### Changed

- 抓取失败按原因说明：拒绝访问或需要人机验证（401/403）、页面不存在、限流、
  网站故障分别提示；X 登录页不再被当成正文保存。
- 书架侧栏改为一行状态筛选并移除分区标签；文章目录改为右侧居中浮层；
  模型接入弹窗可点击遮罩关闭。
- 界面中写死的「中文译文 / 中文图」改为「译文 / 译图」，导出文件名带目标语言。
- Text provider selection is explicit (`api` / `agy` / `codex`); the old `auto`
  fallback to a local agent was removed. New installs default to `api` and must
  be configured before importing an article.
- The setup page configures model API only; image settings are collapsed and
  default to the same multimodal text model. Local agy/Codex are configured via
  environment variables, not the page.
- Import shows an API/agy/Codex selector when more than one provider is usable;
  it hides automatically when only one is available.

### Known limitations

- No public hosting, multi-user authentication or container deployment in this
  release.
- Real provider compatibility, quota behavior and rate limits are verified
  manually; see `docs/COMPATIBILITY.md` once populated.
- Windows local CLI agents are not supported. macOS/Linux CLI agents depend on
  the installed CLI version and account.
- LaTeX and Mermaid are not rendered; Markdown editing is not live.
