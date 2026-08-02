## Why

当前上游仅返回 `deepseek-v4-flash` 或 `deepseek-v4-pro` ID 时，服务无法补全 DeepSeek 官方的 1,000,000 tokens 上下文和可用思考档位，导致设置页与对话编辑器退化为 `none`。更严重的是，Chat Completions 选择 `none` 时只会省略参数，而 DeepSeek 默认仍启用高思考。

## What Changes

- 为已核验的 `deepseek-v4-flash` 和 `deepseek-v4-pro` 添加本地官方能力目录条目，覆盖官方上下文、默认思考等级和可区分的实际思考档位。
- 让模型发现、配置恢复、设置页回填和会话级模型选择从该目录获得能力，而不依赖上游 `/models` 的可选元数据。
- 为官方 DeepSeek V4 精确匹配模型补齐 OpenAI Chat Completions 与 Responses 的思考请求参数，确保 `none` 真实关闭思考。
- 为能力映射与请求体增加单元测试，隔离非官方或同前缀模型，避免向任意 OpenAI 兼容网关注入 DeepSeek 专有参数。

## Capabilities

### New Capabilities

<!-- 无。 -->

### Modified Capabilities

- `model-capability-catalog`: 为 DeepSeek V4 官方模型增加精确能力映射，并将支持的思考模式落实到对应请求协议。

## Impact

- 影响 `src/server/model-capability-catalog.js`、`src/server/runtime-config.js` 和 `src/server/provider-client.js`。
- 影响模型能力和提供方请求的服务端单元测试；任务窗格会通过现有本地配置接口自动获得补全结果，无需向外部网页发送模型 ID 或令牌。
- 不改变 Excel WebView 与 API Key 的隔离边界，也不处理 DeepSeek `reasoning_content` 的展示或多轮保留。
