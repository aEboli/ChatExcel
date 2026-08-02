## Why

官方 ChatGPT for Excel 不能读取用户电脑上的 Codex 配置，也不能指向当前的本地 Sub2API。用户需要一个类似 Obsidian Claudian 的 Excel Agent：自动复用本机模型配置，同时具备对工作簿的读取、公式、写入、格式、表格和图表操作能力。

## What Changes

- 新建一个名为 ChatExcel、功能区缩写为 ChatEx 的自托管 Excel Office.js 任务窗格加载项和回环地址本地服务。
- 本地服务每次请求从用户级 `config.toml` 解析当前模型、提供方、接口地址和凭据，Excel WebView 只获得脱敏状态。
- 使用统一的函数工具协议编排多步 Agent 循环，并通过适配层支持 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 和 Google Gemini generateContent，由 Excel 端执行受控的 Office.js 工具。
- 提供工作簿读取、值与公式写入、格式设置、表格创建、图表创建和工作表管理工具。
- 提供“需要审批”和“无需审批”两种醒目模式；需要审批时逐项确认，无需审批时先告知再直接执行。
- 将用户最后一次审批选择作为非敏感偏好持久化，在刷新任务窗格或重启本地服务后恢复。
- 任务窗格每次启动都对当前模型提供方执行无提示词、无工作簿内容的短超时连通性测试；模型选择器和设置齿轮按结果显示绿色或红色。
- 把紧凑操作记录置于对话上方，并提供可点击的历史上下文视图；处于历史视图时，继续对话或手动修改工作簿均需再次确认。
- 在输入框底部提供模型、思考等级、上下文占用和审批模式控制；控制带优先单行展示，空闲提示不占据整块对话区。
- Excel 任务窗格宽度由宿主决定；窄窗格下底部控制有序换行，完整保留审批和发送控件。
- 提供毛玻璃设置页；默认使用系统 Codex 配置，也可选择常见协议并长期保存自定义 API 根地址、API Key、模型、上下文长度和思考等级映射；API 根地址无需手动填写 `/v1`、`/v1beta` 或具体端点。
- 自定义 API Key 使用 Windows 当前用户 DPAPI 加密后写入 `%APPDATA%\ChatExcel\settings.json`，系统/自定义模式切换和本地服务重启不得丢失配置。
- 设置页允许把单次 Agent 任务的模型步骤上限配置为 1 到 1000，默认 100，并与配置来源开关一起长期保存。
- 提供本地 HTTPS 启动、Excel 侧载、健康检查、卸载和故障排查流程。
- 不发布到 Microsoft Marketplace，不复用或分发第三方闭源加载项资源。

## Capabilities

### New Capabilities

- `local-codex-configuration`: 安全读取并解析用户级 Codex 配置，解析当前 Responses 提供方且不向 Excel 暴露凭据。
- `responses-agent-orchestration`: 通过协议适配层执行可取消、有限轮次、失败关闭的函数工具循环，并把四种提供方响应归一化为同一会话格式。
- `excel-workbook-automation`: 在当前工作簿中执行可审计的读取、公式、写入、格式、表格、图表和工作表操作。
- `local-addin-runtime`: 在 Windows 回环地址上托管任务窗格、提供健康状态并完成 Excel 开发侧载与移除。
- `taskpane-experience`: 提供 ChatExcel 的工作簿感知界面、紧凑审计记录、模型控制、设置、文本输入和历史修改保护。

### Modified Capabilities

无。

## Impact

- 新增 Node.js 本地服务、Office.js 前端、Excel 清单、测试和中文运维文档，并把加载项显示名称改为 ChatExcel / ChatEx。
- 新增 TOML 解析与 Office 开发证书/侧载工具依赖。
- 默认读取 `~/.codex/config.toml`；关闭系统配置后，自定义 API Key 只以 Windows 当前用户 DPAPI 密文持久化，明文仅在本地服务进程内使用。用户指令和必要的工作簿上下文只发送到当前选择的模型提供方。
- 需要 Microsoft Excel 桌面版、Node.js 20 以上版本、Windows PowerShell 和至少一个兼容 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 或 Google Gemini generateContent 的提供方。
