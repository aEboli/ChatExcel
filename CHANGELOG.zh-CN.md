# 更新日志

这里记录 ChatExcel 的重要版本变化。

## [0.0.2] - 2026-08-02

### 新增

- 面向既有 `.xls` 工作簿的原生伴随路径。Windows 启动器只打开原始旧格式路径，让 Excel 保持文件格式控制权，并通过一次性、仅当前 Windows 用户可访问的管道执行已批准工具。
- 使用 DPAPI 加密的当前工作簿崩溃恢复缓存，配合 30 分钟任务窗格存活租约。恢复绝不会自动重发模型请求或重放 Excel 操作。
- 有界的本地服务恢复守护器：仅在 ChatExcel 受管服务异常退出或持续不健康后重启它。
- 操作历史步骤的只读可视化预览，范围或图表截图受尺寸限制，无法截图时回退为网格；预览不会保存或修改工作簿。

### 变更

- Responses、Chat Completions、Anthropic Messages 和 Gemini 中可关联的模型工具失败会返回结构化错误，让 Agent 在不触碰工作簿的前提下纠正无效工具名、参数和范围。
- A1 地址现在支持整行和整列；紧凑任务窗格只接收文本任务。
- 启动器打包从 npm 元数据读取发行版本，生成 `ChatExcel-Launcher-0.0.2-win-x64.zip` 及匹配的 SHA-256 文件。

### 已知限制

- 原生 `.xls` 伴随路径需要桌面版 Microsoft Excel 和 WebView2；兼容模式下的表格和图表行为须在目标工作簿中验收后再用于生产操作。
- 真实桌面 Excel 的长时间流式取消仍需要可控提供方的专用验收。

## [0.0.1] - 2026-08-01

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
[0.0.2]: https://github.com/aEboli/ChatExcel/releases/tag/v0.0.2
