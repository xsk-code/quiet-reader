# 架构与接口

Node.js 本地服务 + 原生浏览器 JavaScript，无前端构建步骤。原文先落盘，正文分段翻译，图片使用独立的全局并发池。

| 文件 | 职责 |
| --- | --- |
| server.mjs | 接口、正文队列、静态资源、运行时组装 |
| lib/settings.mjs | 非秘密配置、本机密钥存储、环境覆盖与原子保存 |
| lib/providers.mjs | API、能力检查、接入分派与连接验证 |
| lib/agents.mjs | CLI 生命周期、超时和安全错误 |
| lib/translate.mjs | Markdown 分段与正文翻译提示 |
| lib/article.mjs | 地址、DNS、抓取提取及分段 |
| lib/images.mjs | 图片发现、下载、并发、去重、重放与耗时 |
| lib/image-insights.mjs | 识别结果校验、导出与历史简图 |
| lib/image-scene.mjs | 受约束场景校验和本地 SVG |
| lib/store.mjs | 文章、阅读状态和 Markdown 落盘 |
| public/ | 书架、阅读、接入配置和自有纸张排版 |
| extension/ | 可选 Chrome/Edge MV3 插件：只提交当前页面或右键链接的 URL，任务进度由阅读页轮询 |
| scripts/package-extension.mjs | 生成只含运行时文件的确定性扩展 zip，并输出 SHA-256 |

## 接入契约

`createModelRuntime(settings)` 提供 `describe()`、`resolve(provider, kind)`、`run(provider, prompt, cwd, options)` 与 `probe(kind)`。正文和图片队列通过函数注入使用，测试替换为本地服务。

正文接入必须显式选择 `api`、`agy` 或 `codex`，不会从 API 自动回退到本地 Agent；图片默认沿用正文 API 的模型；也可显式选择独立 `api`、`agy` 或 `none`。

API 请求 `POST <baseURL>/chat/completions`，包含 `model`、`messages`、`stream: false`；视觉请求用 `text` 和 `image_url` 内容段，以 base64 data URI 发送实际原图，不要求模型读本地路径。

协议依据：[官方接口参考](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。只使用通用字段，不自动增加工具、存储、温度或特定推理参数；不同服务兼容性需验证。

新增适配器时，更新配置枚举、能力描述、解析和 `run` 分派，为正文、视觉、超时、错误脱敏、缺能力降级补测试。不要把服务选择写入 SVG 渲染器。

## 本地接口

| 方法与路径 | 行为 |
| --- | --- |
| GET /api/health | 版本、服务身份、目录、正文／图片接入是否就绪 |
| GET /api/status | health 字段 + 任务数与图片并发状态 |
| GET /api/setup | 非秘密配置、静态能力、`languages` 与环境默认的 `targetLanguage` |
| PUT /api/setup | 保存配置与可选 write-only 密钥；任务或验证进行中拒绝修改 |
| POST /api/setup/models | `{ "baseURL": "...", "apiKey": "..." }`；读取服务端 `/models` 列表，不保存密钥 |
| POST /api/setup/probe | `{ "kind": "text" }` 或 image；发送小型模型验证请求 |
| POST /api/import | `{ "content": "链接或正文", "provider": "api", "targetLanguage": "en" }`；provider 可省略，省略时使用已保存接入；targetLanguage 可省略，省略时用 `READER_TARGET_LANGUAGE`，再退回 `zh-CN`；返回任务 |
| GET /api/jobs/:id | 正文任务进展；抓取阶段失败时带 `fetchFailed: true` 与 `sourceURL`，页面据此提供「打开原文」「粘贴正文」 |
| GET /api/articles | 未删除文章及状态 |
| POST /api/articles/:id/translate | 正文重试，支持 api/agy/codex 与 `targetLanguage`；同一语言下从未完成的段落继续 |
| POST /api/articles/:id/images | 图片重试，`{ "redraw": true }` 升级旧结果 |
| PATCH /api/articles/:id | 收藏或阅读状态 |
| DELETE /api/articles/:id | 可恢复删除 |
| POST /api/articles/:id/restore | 撤销删除 |

只允许本机 Host 与同源浏览器请求。唯一例外是 `chrome-extension://` 来源：仅为 `POST /api/import` 回显 CORS 预检和响应；其他接口继续拒绝，扩展也不能读取文章库或配置。配置接口接受 write-only 密钥字段，保存到数据目录的 `secrets.json`（0600），从不在响应中返回，也不写入 `settings.json` 或浏览器存储；环境变量优先。显式配置的模型地址和文章链接使用不同路径，不要放宽文章抓取的公网限制。

扩展把 URL 交给服务后，由阅读页轮询 `/api/jobs/:id` 并跳转到文章；`/?pending=<url>` 只在服务不可达时预填导入栏，不自动消耗模型调用。

错误响应为 `{ "error": "...", "code": "..." }`，HTTP 状态按代码映射：`MODEL_NOT_CONFIGURED` 409、`IMAGE_RATE_LIMIT` 429、`MODEL_HTTP` 502（`upstreamStatus` 保留服务商状态）、`MODEL_TIMEOUT` 504、`IMAGE_VALIDATION` 422。服务启动时在数据目录写入 `.lock`，用 PID 防止两个进程同时写文章库；SIGINT/SIGTERM 会释放锁并关闭监听。

## 正文翻译与续翻

正文按约 9000 字符分段串行翻译。每段完成后写入文章的 `translationDraft`（段落哈希 + 目标语言 + 已完成段落）。`MODEL_TIMEOUT`、`MODEL_CONNECTION`、HTTP 429 和 5xx 会在 5 秒、15 秒后各重试一次；401/403、输出截断等直接失败。重试时只有原文分段与目标语言都相同才复用草稿，成功后清空草稿并记录 `targetLanguage`。图片识别缓存和本地重放记录按目标语言区分，换语言重译会重新识别图片。

## 图片生命周期

下载并校验原图 → 内容哈希去重 → 视觉识别 → 先保存 recognition.json → 结构校验 → 本地 SVG → 只替换译文图片引用。

- 默认全局 2 个工作槽。429 后暂停排队任务，已发出请求可收尾。
- 同内容共享一个识别 Promise，各自落盘；失败清除相应缓存。
- 记录绑定 URL、原图哈希和源文件；有效记录可本地重放，无效时才重新识别一次。
- 模型只返回数据；SVG 渲染器仅接受固定元素、数字、颜色和转义文字。
- 原始模型输出留在数据目录；界面不回显提供商原始错误或凭证。

timings.json 记录阶段耗时和失败原因。recognizingMs 包含进程／网络／读图／输出，agentStartupMs 是其子集。排队耗时 queueMs、处理尝试次数和上一轮结果另保存在文章记录中，均为本地诊断。

## 验证边界

测试使用隔离文章库和本机模拟 API。真实账号权限、模型视觉能力、限流和并发吞吐需用对应账号实测。模拟延迟只能验证等待可重叠，不能作为模型速度承诺。
