## Why

当前设置页只读取 Codex `config.toml`，而新版 Codex CLI 将凭据放在同目录的 `auth.json`；这会让本机配置明明存在却显示不可用。配置读取失败时页面又隐藏自定义 API 表单，用户无法修复或切换到自定义接口；Claude CLI 的用户级配置也没有可选同步入口。

## What Changes

- 读取 Codex CLI `auth.json` 中的 `OPENAI_API_KEY`，并兼容 `model_reasoning_effort = "ultra"`。
- 增加 Claude CLI `~/.claude/settings.json` 的 Anthropic 配置读取。
- 提供自动（优先 Codex）、Codex CLI、Claude CLI 三种系统来源选择，并持久化选择。
- 系统配置不可用时保持自定义 API 表单可见。
- 保持令牌只在本地 Node.js 服务中使用，不返回到 Excel WebView。

## Capabilities

### New Capabilities

- `local-cli-config`: 从本机 Codex 或 Claude CLI 配置安全加载系统模型配置。
- `settings-recovery`: 系统配置失败时仍可进入自定义 API 修复流程，并选择系统 CLI 来源。

### Modified Capabilities

## Impact

影响 `src/server/config.js`、新增的系统配置加载模块、运行时配置和 DPAPI 设置存储、任务窗格设置 UI，以及对应 Node 测试和本地服务启动行为；不新增第三方依赖，不改变 Excel WebView 访问令牌的安全边界。
