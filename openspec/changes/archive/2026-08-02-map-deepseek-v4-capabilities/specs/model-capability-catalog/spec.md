## MODIFIED Requirements

### Requirement: 解析官方模型能力目录
本地服务 MUST 为已发现的、与内置官方目录精确匹配的模型 ID 返回目录定义的上下文长度、支持的思考等级和默认思考等级。官方只公开思考模式而未公开等级枚举时，系统 MUST 返回提供方自动模式，而不得臆测 `reasoning_effort` 值。目录条目 MUST 记录其官方来源，且模型发现 MUST NOT 为获取能力信息而向厂商网页或其他第三方发送模型 ID、API Key 或配置内容。

对于官方 DeepSeek V4 条目，系统 MUST 仅以 `deepseek-v4-flash` 和 `deepseek-v4-pro` 的精确 ID 应用目录能力。Flash MUST 返回 1,000,000 tokens 上下文、`none`、`low`、`high`、`max` 思考模式和默认 `high`；Pro MUST 返回 1,000,000 tokens 上下文、`none`、`high`、`max` 思考模式和默认 `high`。`none` MUST 表示官方定义的关闭思考模式。

#### Scenario: 仅有模型 ID 的 Qwen3.7 Max 被补全
- **WHEN** OpenAI Chat Completions 模型接口只返回 `qwen3.7-max` 的 ID
- **THEN** 返回的模型条目包含官方目录定义的 1,000,000 tokens 上下文、提供方自动思考模式和官方来源标记，且不伪造标准思考等级

#### Scenario: 目录条目覆盖冲突的上游元数据
- **WHEN** 上游模型元数据为已命中官方目录的模型声明了不同的上下文或思考等级
- **THEN** 返回的模型条目使用官方目录值而不是冲突的上游值

#### Scenario: 仅有模型 ID 的 DeepSeek V4 Flash 被补全
- **WHEN** OpenAI Chat Completions 模型接口只返回 `deepseek-v4-flash` 的 ID
- **THEN** 返回的模型条目包含官方目录定义的 1,000,000 tokens 上下文、`none`、`low`、`high`、`max` 思考模式、默认 `high` 和官方来源标记

#### Scenario: 同前缀模型不被误标为 DeepSeek V4
- **WHEN** 模型接口返回 `deepseek-v4-flash-preview` 或其他未在目录中精确列出的 ID
- **THEN** 系统不得为该模型添加 DeepSeek V4 的官方上下文、思考模式或专有传输控制

## ADDED Requirements

### Requirement: 使用官方能力控制 DeepSeek 思考请求
当当前协议与模型 ID 精确匹配带有 DeepSeek 思考控制的官方目录条目时，本地服务 MUST 以 DeepSeek 官方格式传递用户已验证的会话级思考选择。该专有控制 MUST NOT 被添加到未命中目录的 OpenAI 兼容模型请求。

#### Scenario: Chat Completions 显式关闭 Flash 思考
- **WHEN** 当前模型为 `deepseek-v4-flash`、协议为 OpenAI Chat Completions 且会话思考等级为 `none`
- **THEN** 请求体包含 `thinking: { type: "disabled" }` 且不包含 `reasoning_effort`

#### Scenario: Chat Completions 启用 Flash 指定档位
- **WHEN** 当前模型为 `deepseek-v4-flash`、协议为 OpenAI Chat Completions 且会话思考等级为 `low`、`high` 或 `max`
- **THEN** 请求体包含 `thinking: { type: "enabled" }` 和同值的 `reasoning_effort`

#### Scenario: Responses 显式关闭 DeepSeek V4 思考
- **WHEN** 当前模型为带有 DeepSeek 思考控制的官方 V4 条目、协议为 OpenAI Responses 且会话思考等级为 `none`
- **THEN** 请求体包含 `reasoning: { effort: "none" }`

#### Scenario: 普通兼容模型保持原请求格式
- **WHEN** 协议为 OpenAI Chat Completions 但模型 ID 未命中 DeepSeek V4 官方目录
- **THEN** 请求体不得因本变更包含 `thinking` 字段
