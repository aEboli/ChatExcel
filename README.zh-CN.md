# ChatExcel 中文说明

<div align="center">
  <img src="assets/icon-80.png" alt="ChatExcel" width="80" height="80" />
  <h1>ChatExcel</h1>
  <p><strong>本地优先的 Microsoft Excel AI 助手</strong></p>
  <p>不离开 Excel，读取当前工作簿、理解活动工作表，并在确认边界内完成修改。</p>
  <p>
    <a href="https://github.com/aEboli/ChatExcel/releases/tag/v0.0.1"><img src="https://img.shields.io/github/v/release/aEboli/ChatExcel?display_name=tag&sort=semver&label=release" alt="0.0.1 发行版" /></a>
    <a href="https://github.com/aEboli/ChatExcel"><img src="https://img.shields.io/github/stars/aEboli/ChatExcel?style=flat&label=stars" alt="GitHub stars" /></a>
    <a href="CHANGELOG.zh-CN.md"><img src="https://img.shields.io/badge/版本-0.0.1-107c41" alt="版本 0.0.1" /></a>
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

**发行版：** [v0.0.1](https://github.com/aEboli/ChatExcel/releases/tag/v0.0.1) · [更新日志](CHANGELOG.zh-CN.md) · [English README](README.md)

## 解决什么问题

很多 Excel 工作需要在模型客户端和工作簿之间反复切换：读取选区、写入公式、统一格式、创建表格或图表。云端加载项通常无法读取电脑上的 Codex 配置，而普通 API 对话又不能安全地操作当前工作簿。

ChatExcel 把 Agent 放在任务窗格中，并只提供受控、可审计的 Excel 工具。读取操作可以自动执行；写入、格式和结构变化可以逐项审批，也可以在明确告知后自动执行。

## 本次发行

`0.0.1` 把完整的本地工作流打包在一起：任务窗格、多协议流式适配、可配置审批循环，以及无需日常安装 Node.js/PowerShell 的自包含启动器。

## 使用流程

1. 在 Excel 的 `ChatEx` 功能区组中打开 ChatExcel。
2. 输入工作簿任务，可直接粘贴或添加最多四张 PNG、JPEG、WebP 图片。
3. 在输入框底部选择模型、思考等级、上下文占用和审批模式。
4. ChatExcel 只把当前任务上下文和已注册的 Excel 工具定义发送给所选提供方。
5. 一次任务的全部工具步骤会合并显示在对话上方，每行先展示实际操作摘要，再展示成功或失败状态；模型文字会随着增量到达逐段显示。
6. Agent 在本地内存会话中继续执行，直到完成、停止或达到步骤上限；步骤上限默认 100，可配置为 1 到 1000。

## 主要能力

- 顶栏显示 `文件名-工作表名`，切换工作表后自动更新。
- 读取工作簿、选区和范围，以及写值、写公式、格式、数字格式、自动调整、清除、工作表、表格、图表和排序。
- 对话上方的紧凑、可折叠操作记录。
- 一次任务一个操作组，默认折叠并在组头显示任务名、步骤预览和步数。
- 点击记录进入历史上下文；继续对话或历史状态下手动改单元格前需要确认。
- `需要审批` 与 `无需审批` 两种颜色区分的修改模式。
- 默认一行、随文字增高的输入框，文件附件、剪贴板图片粘贴、预览和删除。
- 四种协议的助手流式输出；工具参数完整后才进行 Schema 校验和 Excel 执行。
- 单一发送控件：运行时显示旋转圆环，鼠标悬停或键盘聚焦时显示停止图标。
- 设置页支持系统 Codex 开关、协议选择、模型发现、上下文长度、思考等级映射和最大步骤数。
- 毛玻璃界面、克制的状态动效，并尊重 `prefers-reduced-motion`。
- 不保存服务端会话、不上传遥测、不提供云端中转，也不上传工作簿快照。

## 一个小小的页脚彩蛋

任务窗格底部的 `ChatEx` 标记藏着一个低调的页脚彩蛋：悬停或键盘聚焦时会显现基线、小物件和行走角色，点击后可以保持动效。空间关系参考了 [Detail 的页脚彩蛋](https://detail.design/zh/detail/footer-easter-egg)，实际画面由本地 CSS 绘制，不增加额外网络依赖；启用减少动效时仍保留入口和静态状态。

## 支持的协议

自定义配置只需要填写 API 主地址，例如 `https://api.openai.com`。ChatExcel 会自动补齐版本和方法路径：

| 协议 | 生成端点 | 模型发现 | 流式输出 |
| --- | --- | --- | --- |
| OpenAI Responses | `/v1/responses` | `/v1/models` | SSE + JSON 回退 |
| OpenAI Chat Completions | `/v1/chat/completions` | `/v1/models` | SSE + JSON 回退 |
| Anthropic Messages | `/v1/messages` | `/v1/models` | SSE + JSON 回退 |
| Google Gemini `generateContent` | `/v1beta/models/{model}:generateContent` | `/v1beta/models` | `:streamGenerateContent?alt=sse` + JSON 回退 |

适配层会转换统一的工具循环、图片、工具调用、工具结果、思考设置、token 用量和各协议 SSE 事件。文字增量会立即转发，工具调用片段会先累积，模型步骤完成后才校验和执行。用户即使粘贴 `/v1`、`/v1beta` 或完整方法后缀，也会被规范化；网关自有路径会保留。

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
- 对话和工作簿片段只在内存中存在，关闭任务窗格或服务后消失。

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

服务地址为 `https://localhost:3210`。侧载脚本注册 `manifest.xml`，通过 Windows App Paths 找到真正的 Microsoft Excel，并打开独立测试工作簿。在 Excel 的 `ChatEx` 组中点击 `Open ChatExcel`。

### Windows 一键加载版

构建便携的 Windows x64 启动器：

```powershell
npm run build:launcher
```

输出目录为 `dist/ChatExcel Launcher/`。双击其中的 `ChatExcel Launcher.exe`，启动器会检查或安装 Office 本地开发证书，启动或复用本地服务，注册加载项，并显式打开 Microsoft Excel。发行目录内置 Node.js 运行时以及服务和 Office 侧载所需的最小依赖，目标电脑不需要另外安装 Node.js 或 .NET；仍然必须安装 Microsoft Excel 桌面版。

也可以直接从 [GitHub Release](https://github.com/aEboli/ChatExcel/releases/tag/v0.0.1) 下载 `ChatExcel-Launcher-0.0.1-win-x64.zip`，解压后双击启动器；旁边的 `.sha256` 文件可用于校验下载完整性。

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
- 把商品或报表截图转换成结构化工作表。
- 在确认后批量填充公式、统一数字格式并自动调整列宽。
- 从现有范围创建原生 Excel 表格或图表，并在执行前查看参数。
- 通过明确支持的协议使用本地 Sub2API 或其他网关。
- 点击历史操作记录查看当时上下文，不把历史视图误解为工作簿回滚。
- 长回答生成过程中即可阅读；方向不对时点击同一个发送位置即可停止当前任务。

## 安全与隐私

- 服务只监听 `127.0.0.1`，并校验请求 `Host` 和 `Origin`。
- 任务窗格不会收到明文或密文 API Key。
- 提供方错误会脱敏凭据；不记录请求正文、Authorization 或工作簿数据。
- 支持的协议使用无服务端会话模式；OpenAI Responses 明确发送 `store: false`。
- Excel 修改仅能通过注册工具执行；未知工具、无效参数、结果不匹配或未审批时失败关闭。
- 不绕过工作表保护、宏、VBA、Power Query 或透视表安全边界。

## 验证

```powershell
npm run check
npm test
npm run validate:manifest
npm audit --omit=dev
openspec validate --changes --strict --no-interactive
```

自动化测试覆盖配置解析、DPAPI 存储边界（使用隔离测试替身）、端点规范化、四种协议适配及其 SSE 增量累积器、图片转换、工具循环、步骤上限、HTTP 来源校验和加载项清单验证。浏览器验收覆盖 400x900 与 320x700，包括默认折叠的任务操作组、展开操作组、单一发送/停止控件、设置持久化、剪贴板图片粘贴、输入框自动增高和无横向溢出。真实桌面 Excel 中使用可控提供方完成长文本流式和中途停止仍是外部验收项。

## 限制

- 侧载需要桌面版 Excel 和受信任的本地开发证书。
- 一键启动器目标为 Windows x64 和 Microsoft Excel 桌面版，不负责把加载项加载到 WPS。
- 不同提供方的模型目录和思考能力不同；缺少元数据时使用保守的模型名映射。
- 不创建工作簿快照，也不提供破坏性工作簿回滚；历史记录只保存上下文，继续前需要确认。
- Microsoft 加载项开发工具属于开发依赖，应独立维护更新。
- 桌面 Excel 的长时间流式取消还需要专用可控提供方冒烟测试；协议流式链路已由自动化测试和本地任务窗格预览覆盖。
- Marketplace 发布和多用户云服务不在本项目范围内。

## 许可证

当前尚未选择许可证。在组织外分发 ChatExcel 前，请补充许可证文件。
