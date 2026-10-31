# 发布验证

本文件用于准备源码发布，不会自动创建公开仓库、上传或发布站点。首次公开的具体勾选项见 [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md)，面向用户的版本说明见 [`RELEASE_NOTES_0.1.0.md`](RELEASE_NOTES_0.1.0.md)。

## 验证顺序

1. `npm ci`：确认锁文件安装成功。
2. `npm test` 和 `npm run verify`：运行单元、本机 HTTP 集成测试和无头安装冒烟，不使用真实凭证。
3. `npm run doctor -- --json`：检查 Node、依赖、存储和配置；`ok` 为安装健康，`ready` 为正文接入已配置。发布门禁使用 `--require-model`。
4. 在隔离数据目录启动，检查首次配置、API-only 正文、图片缺能力降级和图片重绘。真实服务权限与限流另用自己的账号验证。
5. 核对 MIT、字体 OFL、第三方来源和文档链接；新依赖或外部服务（例如 FxTwitter）必须已在 `THIRD_PARTY_NOTICES.md` 记录许可与版权，并在 README「致谢」里署名。
6. 提交经审核的源码后，运行 `npm run extension:zip` 生成扩展包并记录 SHA-256；zip 位于忽略的 `release/`，不进入源码快照。
7. 运行 `npm run release:source` 生成当前 HEAD 的源码快照。
8. 解压快照到全新目录，重新执行 `npm ci`、`npm test`、`npm run verify` 和启动检查。

CI 已配置 macOS、Linux、Windows 与 Node.js 22、24。先在**私有 origin** 推送并确认全绿，再从干净快照建立公开仓库；公开仓库首次推送后再核对一次实际 CI 结果。真实服务的权限、并发和限流仍需按 [`COMPATIBILITY.md`](COMPATIBILITY.md) 用对应账号手工验收，不要把未验证的服务写进支持矩阵。

## 使用干净源码快照

本地开发历史包含过旧主题参考和个人环境路径。公开分发建议使用审核后的当前源码快照，并在新的公开仓库中建立历史，避免直接公开尚未检查的开发历史。

`release:source` 要求工作区干净，拒绝已跟踪的数据目录、密钥环境文件、日志、Agent 私人目录和依赖目录。输出位于忽略的 `release/` 下，快照不含 `.git` 历史。

源码快照包含 `extension/`，但不包含打包后的 zip。需要分发扩展时，可在解压后的快照目录运行 `npm run extension:zip`，把 zip 和 SHA-256 一起作为 Release 附件。

该检查不替代人工审查：还需核对示例、截图、提交内容以及第三方资源。不要用许可证覆盖第三方文章、图片或依赖。

## 当前范围

- 本机服务、CLI 接入、兼容文本／视觉 API、非秘密配置和显式连接验证。
- 可选 Chrome/Edge 一键导入扩展；只把页面或链接网址交给本机导入接口，不读取正文或 Cookie。
- Windows 支持 API-only；本地 `.cmd`/`.bat` Agent 不作为支持项。
- 本地优先保存，图片受约束 SVG，双并发、去重、重放及耗时诊断。
- 不承诺所有兼容端点、所有网页、所有图表都可用；不承诺模拟实验的提速等于真实模型提速。
- 不提供公网、多用户或托管部署。不要在未补鉴权的情况下修改监听地址。
