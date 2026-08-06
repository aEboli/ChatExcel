## Context

OpenAI 官方 `GET /v1/models` 只保证模型基本信息，不保证返回支持的 `reasoning.effort` 子集；第三方 OpenAI-compatible 网关返回 `supported_reasoning_efforts` 等字段属于可选扩展。当前运行配置中的 `qwen3.7-max` 因目录只记录提供方自动模式而得到空 `reasoningEfforts`，任务窗格随即禁用选择器。目录外的 GLM、Kimi、MiniMax 等仅 ID 模型则被推断为 `none`，但普通兼容请求会省略该参数，因此“关闭”展示也不准确。

百炼官方资料进一步区分同一模型的两种协议：`qwen3.7-max` 在 Chat Completions 下使用 `enable_thinking` 和可选的 `thinking_budget`，不支持 `reasoning_effort` 枚举；在兼容 Responses API 下则支持 `none`、`minimal`、`low`、`medium`、`high`，默认 `medium`。Chat Completions 没有官方低中高预算映射，不能把协议通用档位直接套用到当前模型。

现有官方能力目录和提供方元数据仍是可信能力来源。兼容选项必须与已证实能力分离，且不能通过设置保存或恢复流程变成模型默认能力。令牌、模型请求和目录解析继续只发生在本地服务端；不增加能力探测生成请求，也不把凭据或请求正文传入 Excel WebView。

## Goals / Non-Goals

**Goals:**

- 让未返回思考等级的未知 OpenAI Responses / Chat Completions 模型仍可在会话输入区选择常用兼容档位。
- 让当前 `qwen3.7-max` 在 Chat Completions 下可选择官方自动/关闭，在 Responses 下可选择官方公布的五个档位。
- 保持“自动”为安全默认，只有用户显式选择时才发送思考参数。
- 明确区分官方/提供方能力与协议兼容选项，并让服务端按当前模型校验选择。
- 修复档位同名、模型切换误选首项和刷新后残留失效选择的问题。

**Non-Goals:**

- 不通过真实生成请求逐档探测能力，不在 400 后自动重试或静默降级。
- 不宣称兼容档位一定受模型支持，也不为未知模型补造上下文长度。
- 不开放设置页任意保存默认思考等级，不为 Qwen3.7 杜撰低中高 `thinking_budget` 预设。
- 不改变 Anthropic Messages、Gemini 或 DeepSeek V4 已有的专有传输规则。

## Decisions

### 1. Qwen3.7 Max 按协议使用两套官方能力

官方能力目录为 `qwen3.7-max` 建立精确的协议分支。OpenAI Chat Completions 条目使用 `reasoningMode: "thinking-toggle"`、已证实的 `none` 操作和空默认值：`null` 表示沿用模型默认开启思考并省略控制字段，`none` 表示发送 `enable_thinking: false`。不向该协议发送 `reasoning_effort`，也不提供未经官方定义的低中高预算档位。

OpenAI Responses 条目使用 `reasoningMode: "levels"`，返回 `none`、`minimal`、`low`、`medium`、`high` 和默认 `medium`，请求通过 `reasoning.effort` 传递。选择器因此能在用户切换协议后呈现真正的离散思考等级，而不会混淆两种请求契约。

选择协议分支而不是为 Chat Completions 发明 `thinking_budget` 预设，是因为官方只公开 256K 最大思维链长度，没有公布各等级对应预算。未来若要提供预算滑块，应作为独立的数值配置变更设计和验证。

### 2. 已证实能力与兼容选项分字段返回

模型条目保留 `reasoningEfforts` 作为官方目录、上游元数据或其它已核验来源的能力集合，并新增 `compatibleReasoningEfforts`。只有未命中专有官方控制、且 OpenAI Responses / Chat Completions 上游缺少可枚举等级时，后者才返回保守的 `low`、`medium`、`high`；`minimal`、`xhigh`、`max` 仍只来自已证实能力或当前系统配置中的显式值。Qwen3.7 Chat Completions 的官方开关条目不使用兼容候选。

采用独立字段而不是把兼容值合并进 `reasoningEfforts`，可以继续准确展示来源，也避免设置保存把未经证实的值固化为模型默认能力。相比完全禁用选择器，这一方案满足兼容网关的手动控制需求；相比暴露全量七档，它降低了不受支持参数导致 400 的概率。

### 3. `null` 是自动状态，兼容档位只属于消息级选择

`自动` 继续在内部表示为 `null`，不把字符串 `auto` 加入 `REASONING_EFFORTS`。当模型只有兼容选项时，设置页默认值和持久化配置仍为 `null`，请求构造器不发送思考参数；用户在输入区显式选择 `low`、`medium` 或 `high` 后，服务端才按当前协议发送该值。

选择器将 `null` 作为兼容菜单的第一项，使用户尝试某个档位后可以明确回到提供方默认。服务端校验使用已证实档位；仅当该集合为空时才使用兼容档位，防止兼容候选扩大已知模型的官方能力边界。

### 4. 统一选择校正并使用模型声明的默认值

前端规范化每个模型条目的数组字段，并通过单一校正函数处理模型点击、配置加载、模型重新发现和重置。顺序为：保留对新模型仍有效的显式选择；否则使用有效的模型默认值；否则使用当前配置模型的有效值；兼容模式最终回到 `null`，已证实等级模式才退到首个有效档位。

这避免以 `none` 开头的官方列表在模型切换时意外关闭思考，也防止刷新后继续提交已从目录移除的旧档位。所选模型缺字段时不再借用另一个模型的档位。

### 5. 中文标签与 API 值一一对应

选择器使用 `none=关闭`、`minimal=最低`、`low=低`、`medium=中`、`high=高`、`xhigh=极高`、`max=最高`。菜单的可访问名称保留对应 API 值，兼容模式明确显示为兼容档位，避免把不同请求值显示成同一个选项。

### 6. 显式 `none` 与自动省略保持不同语义

OpenAI 协议下的 `null` 始终省略思考参数；当官方目录、上游元数据或显式系统配置允许 `none` 且用户选择它时，请求必须显式关闭思考。普通 Responses 使用 `reasoning.effort: "none"`，普通 Chat Completions 使用 `reasoning_effort: "none"`，Qwen3.7 Chat Completions 使用 `enable_thinking: false`，DeepSeek V4 继续使用已有的 `thinking.type` 专有控制。

## Risks / Trade-offs

- [兼容 API 不接受 `low`、`medium` 或 `high`] -> 默认保持自动且不发送参数，错误原样安全返回，用户可切回自动；不自动重试以避免重复执行和额外费用。
- [用户在 Qwen3.7 Chat Completions 中需要精细等级] -> 当前只提供官方自动/关闭；设置页说明 Responses 协议才有官方离散等级，不伪造预算映射。
- [第三方网关复用官方模型 ID 但实现不同] -> 官方目录优先级保持不变；兼容选项只在官方未枚举等级时出现，不扩大已有官方列表。
- [旧客户端不认识新增字段] -> 继续返回现有字段；旧客户端仍保持原行为，新客户端才读取 `compatibleReasoningEfforts`。
- [刷新导致当前选择失效] -> 前端立即校正为该模型默认或自动，服务端仍进行最终逐模型校验。

## Migration Plan

1. 部署后模型目录响应增加 `compatibleReasoningEfforts`，并按协议刷新 Qwen3.7 能力；旧配置和凭据格式不变。
2. 已保存的 provider-default 模型继续以 `null` 恢复；兼容选择仅存在于当前会话请求和恢复快照中。
3. 回滚时移除新增字段及前端兼容菜单即可恢复原有自动/禁用行为，无需迁移用户数据。

## Open Questions

无。若后续产品需要 Chat Completions 的 Qwen 思考预算，必须单独设计数值滑块、上限校验和请求字段；在官方未提供等级映射前不得把本地预算预设标成官方档位。
