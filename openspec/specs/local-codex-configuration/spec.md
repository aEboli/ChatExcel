# 本机 Codex 配置规格

## Purpose

定义本地服务读取当前用户 Codex Responses 配置、解析凭据并向任务窗格提供脱敏状态的行为。

## Requirements

### Requirement: 解析当前用户级 Codex 配置
系统 MUST 从 `CODEX_HOME/config.toml` 或用户目录下 `.codex/config.toml` 读取当前 `model_provider`、`model`、可选的 `model_reasoning_effort`、可选的 `model_verbosity` 和对应提供方配置，并且 MUST 仅接受 `wire_api = "responses"` 的提供方。

#### Scenario: 成功解析自定义 Responses 提供方
- **WHEN** 配置选择一个包含 `base_url`、`wire_api = "responses"` 和可用凭据的自定义提供方
- **THEN** 系统返回内部可用的模型、Responses URL 和认证信息

#### Scenario: 拒绝非 Responses 提供方
- **WHEN** 当前提供方缺少 `wire_api` 或其值不是 `responses`
- **THEN** 系统返回可识别的配置错误并且不发送模型请求

### Requirement: 支持安全的令牌来源
系统 MUST 支持从提供方的 `experimental_bearer_token` 或 `env_key` 指定的环境变量取得令牌，并且 MUST 在令牌不存在时失败关闭。

#### Scenario: 环境变量令牌不存在
- **WHEN** 提供方声明 `env_key` 但对应环境变量为空
- **THEN** 系统报告令牌未配置且不向提供方发送请求

### Requirement: 凭据保持在服务端
系统 MUST NOT 在任务窗格响应、静态资源、工作簿设置、浏览器存储或普通日志中返回或记录模型令牌。

#### Scenario: 查询脱敏配置状态
- **WHEN** Excel 任务窗格请求当前配置状态
- **THEN** 响应只包含提供方、模型、脱敏接口地址、协议和凭据是否存在，不包含令牌值

### Requirement: 配置变更自动生效
系统 SHALL 在每个模型步骤开始前重新读取配置文件，而不要求重新侧载 Excel 加载项。

#### Scenario: 会话中修改模型
- **WHEN** 用户在两次模型步骤之间修改 `config.toml` 中的模型
- **THEN** 下一次模型步骤使用新模型且状态接口反映新配置
