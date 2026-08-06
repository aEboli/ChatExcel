## MODIFIED Requirements

### Requirement: 解析官方模型能力目录
本地服务 MUST 为已发现的、与内置官方目录精确匹配的模型 ID 返回目录定义的上下文长度、支持的思考等级、默认思考等级和协议专有控制。官方只公开思考模式而未公开等级枚举时，系统 MUST 返回提供方自动模式，不得把协议兼容选项并入已证实的 `reasoningEfforts`；系统 MAY 通过独立的 `compatibleReasoningEfforts` 返回会话级兼容候选。目录条目 MUST 记录其官方来源，且模型发现 MUST NOT 为获取能力信息而向厂商网页或其他第三方发送模型 ID、API Key 或配置内容。

对于官方 `qwen3.7-max` 精确 ID，OpenAI Chat Completions 条目 MUST 提供自动和 `none` 关闭操作，MUST 使用 Qwen `enable_thinking` 控制且 MUST NOT 声称或发送 `reasoning_effort` 档位；OpenAI Responses 条目 MUST 返回 `none`、`minimal`、`low`、`medium`、`high` 和默认 `medium`。

对于官方 DeepSeek V4 条目，系统 MUST 仅以 `deepseek-v4-flash` 和 `deepseek-v4-pro` 的精确 ID 应用目录能力。Flash MUST 返回 1,000,000 tokens 上下文、`none`、`low`、`high`、`max` 思考模式和默认 `high`；Pro MUST 返回 1,000,000 tokens 上下文、`none`、`high`、`max` 思考模式和默认 `high`。`none` MUST 表示官方定义的关闭思考模式。

#### Scenario: 仅有模型 ID 的 Qwen3.7 Max 被补全
- **WHEN** OpenAI Chat Completions 模型接口只返回 `qwen3.7-max` 的 ID
- **THEN** 返回的模型条目包含官方目录定义的 1,000,000 tokens 上下文、`thinking-toggle` 模式、可显式关闭的 `none`、空默认值、Qwen 专有控制和官方来源标记，且不包含 `low`、`medium`、`high` 的 Chat Completions 档位

#### Scenario: Responses 中的 Qwen3.7 Max 被补全
- **WHEN** OpenAI Responses 模型接口只返回 `qwen3.7-max` 的 ID
- **THEN** 返回的模型条目包含官方目录定义的 1,000,000 tokens 上下文、`none`、`minimal`、`low`、`medium`、`high`、默认 `medium` 和官方来源标记

#### Scenario: 目录条目覆盖冲突的上游元数据
- **WHEN** 上游模型元数据为已命中官方目录的模型声明了不同的上下文或思考等级
- **THEN** 返回的模型条目使用官方目录值而不是冲突的上游值

#### Scenario: 仅有模型 ID 的 DeepSeek V4 Flash 被补全
- **WHEN** OpenAI Chat Completions 模型接口只返回 `deepseek-v4-flash` 的 ID
- **THEN** 返回的模型条目包含官方目录定义的 1,000,000 tokens 上下文、`none`、`low`、`high`、`max` 思考模式、默认 `high` 和官方来源标记

#### Scenario: 同前缀模型不被误标为 DeepSeek V4
- **WHEN** 模型接口返回 `deepseek-v4-flash-preview` 或其他未在目录中精确列出的 ID
- **THEN** 系统不得为该模型添加 DeepSeek V4 的官方上下文、思考模式或专有传输控制

### Requirement: 未知模型安全降级
系统 MUST 只为官方目录可识别的模型宣称官方能力。未命中目录的模型 MUST 优先保留上游明确声明的能力；OpenAI Responses 或 OpenAI Chat Completions 上游未声明思考等级时，系统 MUST 保持已证实的 `reasoningEfforts` 为空、默认使用提供方自动模式，并通过独立字段返回 `low`、`medium`、`high` 协议兼容候选。未命中目录且无上游上下文时，系统 MUST NOT 伪造官方上下文长度。

#### Scenario: 未知模型带有上游元数据
- **WHEN** 未知模型的上游条目包含有效的上下文和思考等级元数据
- **THEN** 系统保留这些值并将对应来源标记为提供方，不用兼容候选扩大已声明的等级集合

#### Scenario: OpenAI 兼容未知模型仅返回 ID
- **WHEN** OpenAI Responses 或 Chat Completions 的未知模型上游条目只包含模型 ID
- **THEN** 系统将默认状态设为自动、保持 `reasoningEfforts` 为空、将 `low`、`medium`、`high` 作为独立兼容候选，且不为该模型添加官方上下文长度

## ADDED Requirements

### Requirement: 能力缺失时提供会话级兼容选择
当未知 OpenAI Responses 或 OpenAI Chat Completions 模型没有可枚举的官方、专有或提供方思考控制时，任务窗格 MUST 提供 `自动`、`low`、`medium`、`high` 会话级选择。`自动` MUST 在内部表示为 `null`，MUST NOT 写入全局思考等级枚举，且 MUST 使请求省略思考参数。兼容档位 MUST NOT 被设置页保存为模型默认能力。命中 Qwen3.7 等协议专有官方控制的模型 MUST 使用该控制，而不得套用通用兼容档位。

#### Scenario: Chat Completions 未返回 Qwen 思考等级
- **WHEN** 当前协议为 OpenAI Chat Completions、当前模型为 `qwen3.7-max` 且模型接口只返回 ID
- **THEN** 会话选择器提供自动和关闭，初始值为自动，不显示低、中、高，设置页仍只读显示该协议的官方控制

#### Scenario: Responses 未返回 Qwen 思考等级
- **WHEN** 当前协议为 OpenAI Responses、当前模型为 `qwen3.7-max` 且模型接口只返回 ID
- **THEN** 会话选择器提供关闭、最低、低、中、高并默认选择中，设置页仍只读显示官方默认值

#### Scenario: 未知兼容模型只返回 ID
- **WHEN** OpenAI Responses 或 Chat Completions 的未知模型没有官方专有控制且模型接口只返回 ID
- **THEN** 会话选择器提供自动、低、中、高并默认选择自动，且把后三项标记为兼容档位

#### Scenario: 用户显式选择兼容档位
- **WHEN** 用户为无已证实等级的 OpenAI Chat Completions 模型选择 `high`
- **THEN** 服务端接受该消息级选择并发送 `reasoning_effort: "high"`，后续工具步骤保持相同选择

#### Scenario: 用户恢复自动模式
- **WHEN** 用户在选择兼容档位后重新选择自动
- **THEN** 消息级值恢复为 `null`，OpenAI 请求不包含 `reasoning` 或 `reasoning_effort`

#### Scenario: 拒绝兼容集合外的档位
- **WHEN** 无已证实等级的模型收到 `minimal`、`xhigh` 或 `max` 消息级选择
- **THEN** 服务端在发送上游请求前返回 `REASONING_EFFORT_UNSUPPORTED`

### Requirement: 思考选择在模型变化后保持有效
任务窗格 MUST 规范化模型能力数组，并在模型切换、配置刷新和模型重新发现后重新校正思考选择。系统 MUST 优先保留对新模型仍有效的显式选择，否则使用有效的模型默认值；兼容模式最终 MUST 回到自动，不得借用其他模型的档位或默认选择数组首项 `none`。

#### Scenario: 切换到具有官方默认值的模型
- **WHEN** 当前选择对新模型无效，且新模型声明默认思考等级为 `medium`
- **THEN** 任务窗格选择 `medium`，而不是该模型列表首项 `none`

#### Scenario: 刷新后当前档位失效
- **WHEN** 模型重新发现结果不再包含当前已选档位
- **THEN** 任务窗格在下一次提交前将选择校正为该模型默认值或自动

#### Scenario: 模型能力字段缺失
- **WHEN** 配置响应中的某个模型没有思考等级数组
- **THEN** 任务窗格将其规范化为空数组，不崩溃、不补造 `none`，也不使用另一个模型的等级

### Requirement: 思考档位名称可唯一辨认
任务窗格 MUST 为不同 API 思考等级显示不同的中文名称和无障碍名称：`none` 为“关闭”、`minimal` 为“最低”、`low` 为“低”、`medium` 为“中”、`high` 为“高”、`xhigh` 为“极高”、`max` 为“最高”。

#### Scenario: 同时显示 xhigh 和 max
- **WHEN** 当前模型同时支持 `xhigh` 和 `max`
- **THEN** 菜单分别显示“极高”和“最高”，其可访问名称也不相同

### Requirement: 自动与显式关闭使用不同请求语义
OpenAI 协议请求 MUST 在消息级思考值为 `null` 时省略思考参数；当当前模型允许 `none` 且用户显式选择 `none` 时，系统 MUST 使用该模型与协议的已证实关闭控制。普通 OpenAI 模型 MUST 发送值为 `none` 的协议思考参数，Qwen3.7 Chat Completions MUST 发送 `enable_thinking: false` 且不得发送 `reasoning_effort`，DeepSeek V4 的专有 `thinking` 控制 MUST 保持不变。

#### Scenario: 已知 OpenAI 模型显式关闭思考
- **WHEN** 已证实支持 `none` 的普通 OpenAI Responses 模型收到消息级 `none`
- **THEN** 请求包含 `reasoning: { effort: "none" }`，且该行为不同于自动模式的参数省略

#### Scenario: Qwen3.7 Chat Completions 显式关闭思考
- **WHEN** `qwen3.7-max` 在 OpenAI Chat Completions 下收到消息级 `none`
- **THEN** 请求包含 `enable_thinking: false`，且不包含 `reasoning_effort` 或 `thinking_budget`

#### Scenario: Qwen3.7 Chat Completions 使用自动思考
- **WHEN** `qwen3.7-max` 在 OpenAI Chat Completions 下收到消息级 `null`
- **THEN** 请求省略 `enable_thinking`、`thinking_budget` 和 `reasoning_effort`，由提供方使用默认思考模式

#### Scenario: Qwen3.7 Responses 选择官方档位
- **WHEN** `qwen3.7-max` 在 OpenAI Responses 下收到消息级 `minimal`
- **THEN** 请求包含 `reasoning: { effort: "minimal" }`，且不包含 Chat Completions 的 `enable_thinking` 或 `thinking_budget`
