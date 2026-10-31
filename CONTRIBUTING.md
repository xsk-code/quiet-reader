# 参与贡献

先阅读 [AGENTS.md](AGENTS.md) 和 [架构说明](docs/ARCHITECTURE.md)。项目保持 Node.js + 原生前端，不需要前端构建链。

```sh
npm ci
npm test
npm run verify
npm run doctor -- --json
npm start
```

- 优先提交范围小、可审查的修改。描述具体问题、修改后的行为以及验证方法。
- 行为变化补相应测试；测试使用临时数据和本机模拟 API，不依赖真实模型账号。Windows 相关改动必须在 `windows-latest` 通过，不要只凭 macOS/Linux 推断。
- 不提交个人文章、`.env`、密钥、日志或依赖目录，不添加遥测。
- 不改变文章 URL 的公网校验，不执行文章或模型返回的指令、HTML 或 SVG。
- 接入适配器、正文翻译和图片渲染保持独立。新增服务时测试缺能力降级、超时、限流和错误脱敏。
- UI 修改检查窄屏、键盘操作、纸页／素白／夜读主题，并附不包含私人文章的截图。
- Issue 请提供 Node 版本、系统、复现步骤、已脱敏的错误码与阶段。不要粘贴原始账号配置或提供商错误全文。
- 安全问题按 [SECURITY.md](SECURITY.md) 私下报告；参与讨论即表示遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

提交贡献即表示你有权提交这些代码，并同意项目自有代码使用 MIT 许可；第三方资源保留各自许可。
