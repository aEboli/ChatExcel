# 更新日志

这里记录 ChatExcel 的重要版本变化。

## [0.0.1] - 2026-08-01

ChatExcel 首个 GitHub 发行版。

### 新增

- Windows x64 `ChatExcel Launcher.exe`：自动检查 Office 开发证书、启动或复用本地 HTTPS 服务、注册加载项并打开 Microsoft Excel。
- 本地优先的提供方配置：可复用当前用户 Codex 配置，也可使用 Windows DPAPI 保护自定义 API Key。
- OpenAI Responses、OpenAI Chat Completions、Anthropic Messages、Google Gemini 四种协议适配，支持 SSE 流式输出和 JSON 回退。
- 工作簿感知的 Excel 工具、需要审批/无需审批模式、按任务分组的操作记录、历史上下文保护、图片附件、剪贴板图片粘贴和可配置步骤上限。
- 受 [Detail 页脚彩蛋](https://detail.design/zh/detail/footer-easter-egg) 启发的 CSS 页脚彩蛋：默认低调，悬停/聚焦时显现，并尊重减少动效设置。
- 中英文 README、架构说明、发行打包、诊断和验证命令。

### 安全边界

- 本地伴随服务只监听回环 HTTPS，并校验 `Host` 与 `Origin`。
- API Key、工作簿数据、提示词、工具结果和图片不会写入仓库或启动器日志。
- 启动器只支持 Windows x64 Microsoft Excel 桌面版，WPS 不属于支持的侧载宿主。

### 已知限制

- 侧载需要受信任的 Office 开发证书和桌面版 Microsoft Excel。
- 真实桌面 Excel 的长时间流式取消仍需要可控提供方的专用验收；协议流式链路和任务窗格预览已由自动化测试覆盖。
- 当前尚未选择许可证；在组织外分发前请补充许可证。

[0.0.1]: https://github.com/aEboli/ChatExcel/releases/tag/v0.0.1
