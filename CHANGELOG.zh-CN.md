# 更新日志

这里记录 ChatExcel 的重要版本变化。

## [0.0.4] - 2026-08-18

> 本次仅同步源码，不创建 `v0.0.4` GitHub Release 或 Windows 启动器发行包；`v0.0.3` 仍是最新打包发行版。

### 新增

- 系统 CLI 配置可选择自动（优先 Codex CLI）、Codex CLI、Claude CLI 三种来源。Codex 可从同目录 `auth.json` 恢复 `OPENAI_API_KEY`，Claude 读取当前用户的 Anthropic 配置；令牌继续只在本地 Node.js 服务中使用。
- 新增可双击运行的 Windows 源码启动器 `首次安装并启动 ChatExcel.cmd`，提供安装、修复和卸载流程，并校验 Node.js、依赖、开发证书、清单和旁加载就绪状态。
- 任务窗格输入区支持拖放 PNG、JPEG、WebP 图片，与既有剪贴板附件流程共存。

### 变更

- 系统配置失败时仍显示自定义 API 表单；系统 CLI 来源会持久化，切换失败时会回滚原有设置。
- Codex 配置兼容 `ultra` 思考等级；已验证的 DeepSeek V4 元数据可在设置页显示单次最大输出能力。
- 旁加载会先启动或复用项目本地服务，再注册加载项并打开 Excel；证书验证继续兼容声明的 Node.js 20 基线。

### 已知限制

- `native-addin/` 是实验性的本地探针，不会随 Windows 启动器分发；在任何分发决定前，仍需真实 Excel 验收和受控签名。
- 真实桌面 Excel 的长时间流式取消、实时工作簿修改和原生 `.xls` 兼容性，仍需要在目标主机做人工验收。

## [0.0.3] - 2026-08-07

### 新增

- 剪贴板 PNG、JPEG、WebP 图片输入，支持只发图片开始任务、固定尺寸缩略图、可访问的预览控制和按协议转换的多模态内容。图片附件只保存在页面内存，明确排除在恢复 checkpoint 外。
- 能力安全的模型和思考控制：已验证的官方元数据与兼容回退选项分开呈现，未知 OpenAI 兼容模型默认使用自动思考。
- 范围型修改增加 `5,000` 个单元格影响保护；成功后返回 `impact` 与读回的 `verification` 摘要。

### 变更

- 在 400px 和 320px 宽度下收紧任务窗格固定区，为对话和工作簿结果留出更多空间。消息正文仍为 12px/17px，桌面端常用控件命中区域不少于 24px，焦点和 reduced-motion 行为保持不变。
- 将 Windows x64 启动器、ZIP 命名、README 下载入口和发行元数据更新为 `0.0.3`。

### 已知限制

- 原生 `.xls` 伴随路径仍需桌面版 Microsoft Excel 和 WebView2；兼容模式下的表格和图表行为须在目标工作簿中验收后再用于生产操作。
- 真实桌面 Excel 的长时间流式取消、实时工作簿修改和原生 `.xls` 兼容性，仍需要在目标主机做人工验收。

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
[0.0.3]: https://github.com/aEboli/ChatExcel/releases/tag/v0.0.3
