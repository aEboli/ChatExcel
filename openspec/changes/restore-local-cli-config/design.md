## Context

现有服务默认解析 `%USERPROFILE%\\.codex\\config.toml`，但 Codex CLI 的 `requires_openai_auth` provider 需要从同目录 `auth.json` 取 `OPENAI_API_KEY`。项目已有 Anthropic Messages 协议适配，但没有读取 Claude CLI 用户配置。设置页只有 `useSystemConfig` 布尔开关，且 `/api/config` 失败时没有可用状态供表单初始化。

## Goals / Non-Goals

**Goals:**

- 在本地服务端解析 Codex CLI 和 Claude CLI 配置，并通过显式来源或自动回退选择当前配置。
- 把来源选择写入现有 ChatExcel 设置文件，旧设置缺失该字段时默认自动模式。
- 在系统配置失败时显示可填写的自定义 API 表单。

**Non-Goals:**

- 不读取 Claude Desktop 配置、项目级配置或浏览器存储。
- 不把令牌、配置原文或认证错误细节返回到 Excel WebView。
- 不改变自定义 API 的 DPAPI 加密格式和协议适配行为。

## Decisions

- **来源策略：** 使用 `auto`、`codex`、`claude` 三个稳定 ID。`auto` 先尝试 Codex，失败后尝试 Claude；显式来源不回退，便于诊断和控制。
- **凭据来源：** Codex 支持 `env_key`、内嵌 bearer token 和 `auth.json.OPENAI_API_KEY`；Claude 只使用 `settings.json.env.ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`。所有令牌在服务进程内存中流转。
- **Claude 模型目录：** Claude CLI 的模型别名作为当前模型保留；模型发现按钮仍复用现有 `/v1/models` 探测，失败时不阻止已加载的当前模型。
- **持久化：** 在现有设置 JSON 增加 `systemSource`，缺失或无效值按 `auto` 处理；保存自定义 key 的 DPAPI 流程不变。

## Risks / Trade-offs

- [Risk] Codex 和 Claude 同时存在但自动模式选择 Codex → Mitigation：设置页提供显式 Claude CLI 选项。
- [Risk] Claude CLI 模型别名可能不被网关接受 → Mitigation：保留原始别名并在生成请求/连通性错误中按既有脱敏路径报告。
- [Risk] 两个 CLI 配置都损坏 → Mitigation：自动模式返回 Codex 主错误并保留失败关闭；设置页仍可切换自定义 API。

## Migration Plan

1. 更新服务和任务窗格后重启本地服务；旧 `%APPDATA%\\ChatExcel\\settings.json` 自动按 `systemSource=auto` 读取。
2. 在设置页选择系统 CLI 来源并保存；切换失败时旧来源和模式回滚。
3. 如需回滚，只需恢复旧源码并重启服务，设置文件中的未知 `systemSource` 会被忽略为自动模式。
