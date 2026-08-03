# ChatExcel 中文说明

<div align="center">
  <img src="assets/icon-80.png" alt="ChatExcel" width="80" height="80" />
  <h1>ChatExcel</h1>
  <p><strong>本地优先的 Microsoft Excel AI 助手</strong></p>
  <p>不离开 Excel，读取当前工作簿、理解活动工作表，并在确认边界内完成修改。</p>
  <p>
    <a href="https://github.com/aEboli/ChatExcel/releases/tag/v0.0.2"><img src="https://img.shields.io/github/v/release/aEboli/ChatExcel?display_name=tag&sort=semver&label=release" alt="0.0.2 发行版" /></a>
    <a href="https://github.com/aEboli/ChatExcel"><img src="https://img.shields.io/github/stars/aEboli/ChatExcel?style=flat&label=stars" alt="GitHub stars" /></a>
    <a href="CHANGELOG.zh-CN.md"><img src="https://img.shields.io/badge/版本-0.0.2-107c41" alt="版本 0.0.2" /></a>
    <a href="README.md"><img src="https://img.shields.io/badge/English-README-1967a6" alt="English README" /></a>
  </p>
</div>

<p align="center">
  <img src="assets/screenshots/taskpane-400x900.png" alt="ChatExcel 任务窗格预览" width="400" />
</p>

<p align="center"><sub>Windows · Microsoft Excel 桌面版 · 本地 HTTPS · 四种流式协议</sub></p>

<div align="center">

| 本地优先 | 修改可审计 | 流式输出 | 一键启动 |
| --- | --- | --- | --- |
| 复用 Codex 配置或连接本地网关 | 读取自动执行，修改明确审批 | Responses、Chat Completions、Messages、Gemini | 自包含 Windows x64 发行版 |

</div>

**发行版：** [v0.0.2](https://github.com/aEboli/ChatExcel/releases/tag/v0.0.2) · [更新日志](CHANGELOG.zh-CN.md) · [English README](README.md)

## 解决什么问题

很多 Excel 工作需要在模型客户端和工作簿之间反复切换：读取选区、写入公式、统一格式、创建表格或图表。云端加载项通常无法读取电脑上的 Codex 配置，而普通 API 对话又不能安全地操作当前工作簿。

ChatExcel 把 Agent 放在任务窗格中，并只提供受控、可审计的 Excel 工具。读取操作可以自动执行；写入、格式和结构变化可以逐项审批，也可以在明确告知后自动执行。

## 本次发行

`0.0.2` 增加当前工作簿的加密崩溃恢复、本地服务恢复守护、可关联工具错误的自动纠正、只读历史预览，以及面向既有 `.xls` 工作簿的原生伴随窗格；旧格式仍由 Excel 自己控制，不会被 ChatExcel 自动转换。

## 当前 main 开发线

当前 `main` 在 `v0.0.2` 的基础上继续强化工作簿修改安全边界：

- 值、公式、格式、数字格式、清除、排序、表格和图表源范围会先读取实际尺寸；超过 `5,000` 个单元格时返回结构化错误，不触碰工作簿。
- 自动调整按实际行数或列数限制目标维度，图表位置只接受有限的单元格或矩形范围。
- 成功修改会返回可审计的 `impact` 和 `verification` 摘要；Office.js 与原生 `.xls` 使用相同的错误码和结果字段。
- Agent 指令要求先读后改、可计算时优先公式，并在任务完成前检查验证摘要和公式错误；`需要审批` 与 `无需审批` 的用户选择语义保持不变。

这些内容已经同步到 GitHub `main`，但尚未创建新的发行标签；`v0.0.2` 仍是当前正式发行版。

## 使用流程

1. 在 Excel 的 `ChatEx` 功能区组中打开 ChatExcel。
2. 输入工作簿任务。
3. 在输入框底部选择模型、思考等级、上下文占用和审批模式。
4. ChatExcel 只把当前任务上下文和已注册的 Excel 工具定义发送给所选提供方。
5. 一次任务的全部工具步骤会合并显示在对话上方，每行先展示实际操作摘要，再展示成功或失败状态；模型文字会随着增量到达逐段显示。
6. 模型生成无效工具名、参数或范围时，ChatExcel 不触碰工作簿，把结构化错误返回给模型并让 Agent 自行修正。
7. Agent 在本地内存会话中继续执行，直到完成、停止或达到步骤上限；步骤上限默认 100，可配置为 1 到 1000。

## 主要能力

- 顶栏显示 `文件名-工作表名`，切换工作表后自动更新。
- 读取工作簿、选区和范围，以及写值、写公式、格式、数字格式、自动调整、清除、工作表、表格、图表和排序。
- 支持单元格、矩形、绝对引用、`N:R` 整列和 `1:3` 整行等常用 A1 地址。
- 范围型修改执行前统一做影响面积保护，成功后读回实际结果；结果中的 `impact` 和 `verification` 可用于审计和后续纠错。
- Responses、Chat Completions、Anthropic Messages 和 Gemini 下，可关联的模型工具错误都会自动回传并继续纠正。
- 对话上方的紧凑、可折叠操作记录。
- 一次任务一个操作组，默认折叠并在组头显示任务名、步骤预览和步数。
- 点击记录进入历史上下文；继续对话或历史状态下手动改单元格前需要确认。
- `需要审批` 与 `无需审批` 两种颜色区分的修改模式。
- 默认一行、随文字增高的文本输入框，紧凑排列模型、思考等级、上下文、审批和发送控件。
- 四种协议的助手流式输出；工具参数完整后才进行 Schema 校验和 Excel 执行。
- 单一发送控件：运行时显示旋转圆环，鼠标悬停或键盘聚焦时显示停止图标。
- 设置页支持系统 Codex 开关、协议选择、模型发现、上下文长度、思考等级映射和最大步骤数。
- 毛玻璃界面、克制的状态动效，并尊重 `prefers-reduced-motion`。
- 不保存长期聊天记录、不上传遥测、不提供云端中转，也不上传工作簿快照。仅在当前工作簿具有稳定标识时，才将一个活动会话写入当前 Windows 用户的 DPAPI 加密本地缓存。任务窗格持续打开时，即使不聊天，定期成功的存活心跳也会保留该缓存；任务窗格或 Excel 窗口关闭或崩溃后，从最后一次成功心跳起 30 分钟删除，明确停止、重置或清空时也会立即删除。

## 一个小小的页脚彩蛋

任务窗格底部的 `ChatEx` 标记藏着一个低调的页脚彩蛋：悬停或键盘聚焦时会显现基线、小物件和行走角色，点击后可以保持动效。空间关系参考了 [Detail 的页脚彩蛋](https://detail.design/zh/detail/footer-easter-egg)，场景由本地 CSS 和仓库内的 `.webp` 角色资源构成，不增加额外网络依赖；启用减少动效时仍保留入口和静态状态。

## 支持的协议

自定义配置只需要填写 API 主地址，例如 `https://api.openai.com`。ChatExcel 会自动补齐版本和方法路径：

| 协议 | 生成端点 | 模型发现 | 流式输出 |
| --- | --- | --- | --- |
| OpenAI Responses | `/v1/responses` | `/v1/models` | SSE + JSON 回退 |
| OpenAI Chat Completions | `/v1/chat/completions` | `/v1/models` | SSE + JSON 回退 |
| Anthropic Messages | `/v1/messages` | `/v1/models` | SSE + JSON 回退 |
| Google Gemini `generateContent` | `/v1beta/models/{model}:generateContent` | `/v1beta/models` | `:streamGenerateContent?alt=sse` + JSON 回退 |

适配层会转换统一的工具循环、兼容客户端图片输入、工具调用、工具结果、思考设置、token 用量和各协议 SSE 事件。任务窗格只接收文本任务。文字增量会立即转发，工具调用片段会先累积，模型步骤完成后才校验和执行。用户即使粘贴 `/v1`、`/v1beta` 或完整方法后缀，也会被规范化；网关自有路径会保留。

![ChatExcel 自定义协议设置](assets/screenshots/settings-400x900.png)

## 架构

```text
Excel 任务窗格（Office.js）
        │ 同源 HTTPS
        ▼
127.0.0.1:3210 本地伴随服务
        │ 协议适配 + 内存会话
        ▼
Codex 配置、自定义提供方或本地网关
```

- 任务窗格负责界面、审批和 Office.js 执行。
- 本地 Node.js 服务负责读取配置、保护凭据、发现模型、转换协议消息和限制会话步骤。
- 提供方只接收当前循环所需的任务输入、工具定义和工具结果。
- 对话和工作簿片段默认只在内存中存在；唯一例外是当前工作簿的加密崩溃恢复缓存，它从最后一次成功任务窗格存活心跳起 30 分钟后过期。

## 技术栈

- Microsoft Excel 桌面版和 Office.js。
- Node.js 20+（当前用 Node.js 24 验证）、原生 ES Modules、Express 5。
- `smol-toml` 解析 Codex `config.toml`。
- Windows 当前用户 DPAPI 加密自定义 API Key。
- Node 内置测试框架和 Microsoft Office 加载项开发工具链。
- `office-addin-dev-certs` 提供本地 HTTPS。
- .NET 8 自包含 Windows x64 启动器，用于可选的一键发行版。

## 安装

环境要求：

- Windows 10/11。
- Microsoft Excel 2019 或 Microsoft 365 桌面版。
- Node.js 20 或更高版本。
- 可用的 `%CODEX_HOME%\\config.toml` / `%USERPROFILE%\\.codex\\config.toml`，或任一支持协议的自定义凭据。

开发模式在仓库目录运行：

```powershell
npm install
npm run icons
npm run certs:install
npm run certs:verify
npm run validate:manifest
npm run start:local
npm run sideload
```

服务地址为 `https://localhost:3210`。`npm run start:local` 会启动仅管理本项目服务的恢复守护器；若受管 Node.js 服务退出或持续不健康，守护器会按有界退避重试，并在既有 HTTPS 健康检查成功后才视为服务已恢复。任务窗格无法加载时显示的黄色错误页来自 Excel 宿主，守护器恢复完成后点击“重试”即可重新加载。`npm run stop:local` 会同时停止服务和恢复守护器。侧载脚本注册 `manifest.xml`，通过 Windows App Paths 找到真正的 Microsoft Excel，并打开独立测试工作簿。在 Excel 的 `ChatEx` 组中点击 `Open ChatExcel`。

### Windows 一键加载版

构建便携的 Windows x64 启动器：

```powershell
npm run build:launcher
```

输出目录为 `dist/ChatExcel Launcher/`。双击其中的 `ChatExcel Launcher.exe`，启动器会检查或安装 Office 本地开发证书，启动或复用带恢复守护的本地服务，注册加载项，并显式打开 Microsoft Excel。受管服务意外退出时，守护器会恢复服务；Excel 任务窗格的宿主错误页恢复后点击“重试”即可重新加载。发行目录内置 Node.js 运行时以及服务和 Office 侧载所需的最小依赖，目标电脑不需要另外安装 Node.js 或 .NET；仍然必须安装 Microsoft Excel 桌面版。

### 打开已有工作簿

通过启动器拖入或打开 `.xlsx`、`.xlsm`、`.xlsb` 时，仍走 Office.js 任务窗格。已有 `.xls` 工作簿会改走内置原生 Excel 伴随窗格：启动器只打开原始绝对路径，通过每次会话独有且仅当前 Windows 用户可访问的管道执行工具，不会自行转换、保存或新建 OOXML 副本。`.xls` 路径需要桌面版 Microsoft Excel 和 WebView2 Runtime；兼容模式不支持的操作会返回明确工具错误，不会静默改变工作簿格式。

也可以直接从 [GitHub Release](https://github.com/aEboli/ChatExcel/releases/tag/v0.0.2) 下载 `ChatExcel-Launcher-0.0.2-win-x64.zip`，解压后双击启动器；旁边的 `.sha256` 文件可用于校验下载完整性。

不启动服务、不注册加载项、只检查发行目录完整性的命令：

```powershell
npm run diagnose:launcher
```

启动器只把脱敏的启动诊断写入 `%LOCALAPPDATA%\\ChatExcel\\launcher.log`，不会保存 API Key、提示词、工作簿数据、工具结果或图片附件。

源码仍可直接用于开发和本地运行；一键启动器只是对现有本地服务和 Excel 侧载脚本的 Windows 包装。

## 配置

### 系统 Codex 模式

ChatExcel 在每个模型步骤开始前读取当前用户的 Codex 提供方。最小 Responses 配置示例：

```toml
model_provider = "local"
model = "your-model"
model_reasoning_effort = "high"
model_verbosity = "medium"

[model_providers.local]
name = "Local Provider"
base_url = "http://localhost:8080"
wire_api = "responses"
env_key = "LOCAL_MODEL_TOKEN"
```

优先使用 `env_key`。现有配置中的 `experimental_bearer_token` 仍可用，但令牌不会返回到任务窗格。

### 自定义提供方模式

在设置页关闭“使用系统 Codex 配置”，选择协议，填写 API 主地址，获取模型，然后选择模型 ID、上下文长度、思考等级和最大步骤数。最大步骤数服务端限制为 1 到 1000，默认 100。

自定义配置保存在 `%APPDATA%\\ChatExcel\\settings.json`。非密钥字段和模式开关以 JSON 保存；API Key 先用当前 Windows 用户 DPAPI 加密再写盘，明文只在本地服务进程运行期间存在。

## 使用场景

- 不离开 Excel，读取当前选区并总结异常。
- 把当前选中的报表数据转换成结构化工作表。
- 在确认后批量填充公式、统一数字格式并自动调整列宽。
- 从现有范围创建原生 Excel 表格或图表，并在执行前查看参数。
- 直接打开既有 `.xls` 工作簿而不转换格式，并在原生伴随窗格中审阅和批准同一套受控操作。
- 通过明确支持的协议使用本地 Sub2API 或其他网关。
- 点击历史操作记录查看当时上下文，不把历史视图误解为工作簿回滚。
- 长回答生成过程中即可阅读；方向不对时点击同一个发送位置即可停止当前任务。

## 安全与隐私

- 服务只监听 `127.0.0.1`，并校验请求 `Host` 和 `Origin`。
- 任务窗格不会收到明文或密文 API Key。
- 提供方错误会脱敏凭据；不记录请求正文、Authorization 或工作簿数据。
- 上游 HTTP、SSE 和协议错误统一经过脱敏处理，不会把令牌、查询认证参数或认证头残留到任务窗格、日志或工具结果中。
- 支持的协议使用无提供方侧会话存储模式；OpenAI Responses 明确发送 `store: false`。崩溃恢复例外仅保存一个当前工作簿会话到当前用户的 DPAPI 加密本地缓存，不会自动重发模型请求或执行 Excel 操作。
- Excel 修改仅能通过注册工具执行。未知工具和无效参数不会执行；具有可靠调用 ID 的失败会回传给 Agent 自行纠正。缺失或重复调用 ID、结果不匹配、未审批、用户停止、只读工作簿和步骤上限仍是强制边界。
- 不绕过工作表保护、宏、VBA、Power Query 或透视表安全边界。

## 验证

```powershell
npm run check
npm test
npm run validate:manifest
npm audit --omit=dev
npm run check:launcher
dotnet build tests/native-smoke/ChatExcel.NativeSmoke.csproj --configuration Release
openspec validate --all --strict
```

当前 `main` 已通过 `npm test` 的 `256/256` 项、`npm run check` 的 `53` 个 JavaScript 文件、Launcher Release 构建和严格 OpenSpec 校验；真实 Microsoft Excel `.xls` smoke 也确认源文件哈希未改变、格式码前后均为 `56`，并覆盖范围策略、写后验证、跨工作簿隔离、表格失败回滚和取消关闭。自动化测试还覆盖配置解析、DPAPI 存储边界（使用隔离测试替身）、端点规范化、四种协议适配及其 SSE 增量累积器、可恢复失败工具结果、有效和无效混合调用、整行整列范围、兼容客户端图片转换、工具循环、步骤上限、HTTP 来源校验、任务窗格布局契约和加载项清单验证。浏览器验收覆盖 400x900 与 320x700，包括默认折叠的任务操作组、展开操作组、单一发送/停止控件、设置持久化、紧凑空闲状态、输入框自动增高和无横向溢出。真实桌面 Excel 中使用可控提供方完成长文本流式和中途停止仍是外部验收项。

## 限制

- 侧载需要桌面版 Excel 和受信任的本地开发证书。
- 一键启动器目标为 Windows x64 和 Microsoft Excel 桌面版，不负责把加载项加载到 WPS；原生 `.xls` 伴随路径还需要 WebView2 Runtime。
- 不同提供方的模型目录和思考能力不同；缺少元数据时使用保守的模型名映射。
- 不创建工作簿快照，也不提供破坏性工作簿回滚；历史记录只保存上下文，继续前需要确认。
- Microsoft 加载项开发工具属于开发依赖，应独立维护更新。
- 桌面 Excel 的长时间流式取消还需要专用可控提供方冒烟测试；协议流式链路已由自动化测试和本地任务窗格预览覆盖。
- 原生 `.xls` 修改仍须在目标桌面 Excel 工作簿中验收后，才能依赖兼容模式下的表格或图表行为。
- Marketplace 发布和多用户云服务不在本项目范围内。

## 许可证

当前尚未选择许可证。在组织外分发 ChatExcel 前，请补充许可证文件。
