## Context

模型能力目录已经用精确 ID 在模型发现、配置恢复和会话模型切换之间共享上下文与思考能力。`deepseek-v4-flash` 和 `deepseek-v4-pro` 尚未在目录中，因此仅返回 ID 的上游会走保守推断，Flash 退化为 `none`。此外，DeepSeek 官方默认开启 `high` 思考，现有 Chat Completions 适配层把 `none` 处理为省略 `reasoning_effort`，无法真正关闭它。

DeepSeek 官方文档同时定义了两种兼容协议：Chat Completions 通过顶层 `thinking.type` 启停，并以 `reasoning_effort` 选择等级；Responses 通过 `reasoning.effort`，其中 `none` 代表关闭。该行为必须只在本地、可审查的官方目录精确匹配后启用，不能依赖上游声明或模型名称前缀。

## Goals / Non-Goals

**Goals:**

- 为 `deepseek-v4-flash` 和 `deepseek-v4-pro` 补全官方 1,000,000 tokens 上下文、默认 `high` 和实际可区分的思考模式。
- 将 Flash 的 `none`、`low`、`high`、`max` 传递为官方请求格式；Pro 只暴露 `none`、`high`、`max`，不把实际映射后的 `low` 或存在官方资料冲突的 `xhigh` 伪装成独立档位。
- 让目录作为显示能力和专有传输控制的唯一来源，并确保未知模型和普通 OpenAI 兼容网关保持原有请求体。

**Non-Goals:**

- 不在运行时抓取 DeepSeek 网页，不向厂商发送模型 ID、配置或令牌以确认能力。
- 不展示、持久化或回传 DeepSeek `reasoning_content`；多轮思考内容的兼容性属于独立变更。
- 不扩大设置页或对话编辑器的权限边界，也不修改用户已有的手工上下文覆盖行为。

## Decisions

### 1. 用精确官方 ID 建立 DeepSeek V4 条目

能力目录将为 `deepseek-v4-flash` 和 `deepseek-v4-pro` 分别定义上下文、默认思考等级、可选档位、官方资料链接和内部 `thinkingToggle` 标识。Flash 的档位为 `none/low/high/max`；Pro 的有效档位为 `none/high/max`。两者的 `none` 均代表官方明示的关闭思考模式，而不是“未声明能力”。

选择精确 ID，而不是 `deepseek.*v4` 正则，是为了避免网关的同前缀别名、未来快照或私有实现被错误标记为官方能力。未命中时继续使用当前上游元数据和保守推断。

### 2. 由请求构造器再次解析目录中的传输标识

`provider-client` 在构造请求体时以当前协议和模型 ID 重新查询官方目录，并仅在条目带有 `thinkingToggle` 时写入 DeepSeek 专有字段。这样内部传输控制不会被持久化到自定义设置、暴露给 Excel WebView，或受上游模型元数据影响。

Chat Completions 对 `none` 写入 `thinking: { type: "disabled" }` 且不写 `reasoning_effort`；其他官方档位写入 `thinking: { type: "enabled" }` 和对应 `reasoning_effort`。Responses 始终写入 `reasoning: { effort }`，使 `none` 也能明确关闭思考，并避免把 OpenAI 的 `summary` 扩展字段发送给 DeepSeek。

### 3. 保持既有 UI 和配置流程

目录解析已经驱动设置页的上下文回填和只读思考等级。新增条目后，设置页会自动展示 1,000,000 和默认 `high`；对话编辑器继续从 `reasoningEfforts` 读取会话级可选档位。`RuntimeConfigStore` 仍负责校验会话级选择，不需要传递内部传输标记。

## Risks / Trade-offs

- [官方 Pro 档位资料的映射说明存在演进] → 仅公开当前实际不同的 `high` 和 `max`，不展示 `xhigh`；后续以官方资料更新目录。
- [使用相同 ID 的第三方网关实现不兼容 DeepSeek 专有字段] → 当前需求的官方 ID 映射以模型 ID 为依据；测试将确保只有精确条目触发字段，出现兼容性问题时可收紧条目的协议或传输标识。
- [启用思考后响应含 `reasoning_content`] → 本次仅修复能力和请求开关；不把未确认的响应保留策略混入本次修改。
- [客户端绕过设置页提交无效档位] → 现有运行时会以官方条目数组验证会话级选择，设置保存仍固定为默认 `high`。

## Migration Plan

1. 发布后，下一次模型发现或配置恢复会根据精确 ID 重建 DeepSeek 条目；已有 API Key 和上下文覆盖不迁移、不外传。
2. 已保存的 DeepSeek 配置在恢复时使用目录默认 `high`，会话级仍可选择目录允许的档位。
3. 如需回滚，移除目录中的 DeepSeek 条目与对应请求分支即可回到原有上游/推断降级，不涉及用户数据迁移。

## Open Questions

无。
