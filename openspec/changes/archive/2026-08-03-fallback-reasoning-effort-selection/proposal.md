## Why

标准 `/models` 接口通常只返回模型基本信息，并不保证提供思考等级；当前 ChatExcel 会因此把未知能力退化成“关闭”或直接禁用选择器，既无法满足兼容 API 的手动选择需求，也会混淆“自动”“关闭”和“未声明能力”。

## What Changes

- 保留“官方目录 -> 提供方元数据 -> 本地推断”的能力优先级，并为未枚举思考等级的未知模型提供默认不发送参数的协议兼容档位，不把这些档位标成官方或提供方能力。
- 按协议补全 `qwen3.7-max`：Chat Completions 提供官方“自动 / 关闭”思考开关并使用 `enable_thinking`，Responses 提供官方 `none/minimal/low/medium/high` 档位；不向 Chat Completions 发送该模型不支持的 `reasoning_effort`。
- 在会话级思考选择中加入可恢复的“自动”状态；仅当用户显式选择兼容档位时才发送对应协议参数。
- 区分 `minimal`、`low`、`xhigh` 和 `max` 的中文名称与无障碍标签，避免不同 API 值显示成同一个选项。
- 统一模型切换、配置刷新和模型重新发现后的选择校正，优先使用模型默认值并阻止失效或跨模型的思考等级继续提交。
- 保持设置页思考等级只读，不允许客户端把兼容档位伪装成模型默认能力。

## Capabilities

### New Capabilities

<!-- 无。 -->

### Modified Capabilities

- `model-capability-catalog`: 为 API 未声明等级的模型提供明确标记的会话级兼容选项，并规范自动状态、精确档位名称和选择校正行为。

## Impact

- 影响 `src/server/runtime-config.js` 的模型能力合并、会话级校验和公开配置结构。
- 影响 `src/server/model-capability-catalog.js`、`src/server/protocols.js` 与 `src/server/provider-client.js` 的协议兼容档位、Qwen 协议能力和显式思考参数传输。
- 影响 `src/taskpane/taskpane.js` 的模型/思考选择展示及刷新校正。
- 增加服务端与任务窗格回归测试；不新增外部请求、依赖或凭据流转，API Key 仍只保留在本地服务端。
