# 模型能力目录规格

## Purpose

定义 ChatExcel 如何为已发现模型应用可审查的官方上下文和思考能力，在模型发现、配置恢复和会话切换中保持一致，并在目录外安全降级，同时保留用户的显式上下文覆盖。

## Requirements

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

### Requirement: 未知模型安全降级
系统 MUST 只为官方目录可识别的模型宣称官方能力。未命中目录的模型 MUST 优先保留上游明确声明的能力；上游未声明思考等级时，系统 MUST 使用当前协议的保守推断。未命中目录且无上游上下文时，系统 MUST NOT 伪造官方上下文长度。

#### Scenario: 未知模型带有上游元数据
- **WHEN** 未知模型的上游条目包含有效的上下文和思考等级元数据
- **THEN** 系统保留这些值并将对应来源标记为提供方

#### Scenario: 未知模型仅返回 ID
- **WHEN** 未知模型的上游条目只包含模型 ID
- **THEN** 系统将思考能力标记为保守推断，且不为该模型添加官方上下文长度

### Requirement: 模型选择回填并保留上下文覆盖
设置页在模型选择变化或模型发现成功后，MUST 用已选模型的官方上下文长度回填上下文输入框；上下文输入框 MUST 保持可编辑。保存后的手工上下文覆盖 MUST 仅适用于保存时的当前模型；运行时临时选择另一个模型时，系统 MUST 优先使用该模型条目的上下文长度。

#### Scenario: 选择官方已知模型
- **WHEN** 用户从已发现模型列表选择具有官方上下文目录条目的模型
- **THEN** 设置页将上下文输入框更新为该模型的官方值，且用户仍可输入合法的不同数值

#### Scenario: 会话临时切换模型
- **WHEN** 已保存模型具有手工上下文覆盖，且会话改为另一个具有目录上下文的模型
- **THEN** 会话配置和上下文占用计算使用临时所选模型的目录上下文，而不是已保存模型的覆盖值

### Requirement: 设置页思考等级不可编辑
设置页 MUST 将模型默认思考等级或提供方自动状态作为只读信息展示，且客户端保存请求 MUST NOT 能改变该值。服务端 MUST 从模型能力条目导出自定义配置的思考等级或自动状态，并在恢复历史配置时重新规范化该值。

#### Scenario: 用户在设置页选择模型
- **WHEN** 用户选择已发现模型
- **THEN** 思考等级控件显示该模型的默认值或“自动（提供方默认）”且不可编辑

#### Scenario: 客户端伪造思考等级
- **WHEN** 自定义配置保存请求提交与模型默认值不同的 `reasoningEffort`
- **THEN** 服务端保存并返回该模型的默认思考等级或自动状态，而不采信伪造值
