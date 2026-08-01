# ChatExcel 中文说明

ChatExcel 是一个自托管的 Microsoft Excel Office.js 加载项，把可以调用 Excel 工具的本地 Agent 放到工作簿旁边。它可以复用当前 Windows 用户的 Codex 配置，也可以连接 OpenAI、Anthropic 或 Gemini 的自定义接口，同时不把 API Key 暴露给 Excel WebView。

[English README](README.md)

![ChatExcel 任务窗格](assets/screenshots/taskpane-400x900.png)

## 解决什么问题

很多 Excel 工作需要在模型客户端和工作簿之间反复切换：读取选区、写入公式、统一格式、创建表格或图表。云端加载项通常无法读取电脑上的 Codex 配置，而普通 API 对话又不能安全地操作当前工作簿。

ChatExcel 把 Agent 放在任务窗格中，并只提供受控、可审计的 Excel 工具。读取操作可以自动执行；写入、格式和结构变化可以逐项审批，也可以在明确告知后自动执行。

## 使用流程

1. 在 Excel 的 `ChatEx` 功能区组中打开 ChatExcel。
2. 输入工作簿任务，可直接粘贴或添加最多四张 PNG、JPEG、WebP 图片。
3. 在输入框底部选择模型、思考等级、上下文占用和审批模式。
4. ChatExcel 只把当前任务上下文和已注册的 Excel 工具定义发送给所选提供方。
5. 操作记录显示在对话上方，每行先展示实际操作摘要，再展示成功或失败状态。
6. Agent 在本地内存会话中继续执行，直到完成、停止或达到步骤上限；步骤上限默认 100，可配置为 1 到 1000。

## 主要能力

- 顶栏显示 `文件名-工作表名`，切换工作表后自动更新。
- 读取工作簿、选区和范围，以及写值、写公式、格式、数字格式、自动调整、清除、工作表、表格、图表和排序。
- 对话上方的紧凑、可折叠操作记录。
- 点击记录进入历史上下文；继续对话或历史状态下手动改单元格前需要确认。
- `需要审批` 与 `无需审批` 两种颜色区分的修改模式。
- 默认一行、随文字增高的输入框，文件附件、剪贴板图片粘贴、预览和删除。
- 设置页支持系统 Codex 开关、协议选择、模型发现、上下文长度、思考等级映射和最大步骤数。
- 毛玻璃界面、克制的状态动效，并尊重 `prefers-reduced-motion`。
- 不保存服务端会话、不上传遥测、不提供云端中转，也不上传工作簿快照。

## 支持的协议

自定义配置只需要填写 API 主地址，例如 `https://api.openai.com`。ChatExcel 会自动补齐版本和方法路径：

| 协议 | 生成端点 | 模型发现 |
| --- | --- | --- |
| OpenAI Responses | `/v1/responses` | `/v1/models` |
| OpenAI Chat Completions | `/v1/chat/completions` | `/v1/models` |
| Anthropic Messages | `/v1/messages` | `/v1/models` |
| Google Gemini `generateContent` | `/v1beta/models/{model}:generateContent` | `/v1beta/models` |

适配层会转换统一的工具循环、图片、工具调用、工具结果、思考设置和 token 用量。用户即使粘贴 `/v1`、`/v1beta` 或完整方法后缀，也会被规范化；网关自有路径会保留。

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

## 安装

环境要求：

- Windows 10/11。
- Microsoft Excel 2019 或 Microsoft 365 桌面版。
- Node.js 20 或更高版本。
- 可用的 `%CODEX_HOME%\\config.toml` / `%USERPROFILE%\\.codex\\config.toml`，或任一支持协议的自定义凭据。

在仓库目录运行：

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

本项目源码即可完成开发和本地使用，不需要额外打包二进制发行版。

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

自动化测试覆盖配置解析、DPAPI 存储边界（使用隔离测试替身）、端点规范化、四种协议适配、图片转换、工具循环、步骤上限、HTTP 来源校验和加载项清单验证。浏览器验收覆盖 400x900 与 320x700、设置持久化、剪贴板图片粘贴、输入框自动增高和无横向溢出。

## 限制

- 侧载需要桌面版 Excel 和受信任的本地开发证书。
- 不同提供方的模型目录和思考能力不同；缺少元数据时使用保守的模型名映射。
- 不创建工作簿快照，也不提供破坏性工作簿回滚；历史记录只保存上下文，继续前需要确认。
- Microsoft 加载项开发工具属于开发依赖，应独立维护更新。
- Marketplace 发布和多用户云服务不在本项目范围内。

## 许可证

当前尚未选择许可证。在组织外分发 ChatExcel 前，请补充许可证文件。
