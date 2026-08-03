## ADDED Requirements

### Requirement: 所有可展示的提供方错误统一脱敏
配置解析、模型发现、普通生成和流式生成路径 MUST 使用同一保守认证信息脱敏器处理错误摘要。该脱敏器 MUST 覆盖 Bearer、Basic、常见 API key 头、JSON 认证字段、查询认证字段和已知配置令牌；任务窗格、日志和结构化错误均不得包含原始凭据。

#### Scenario: 模型发现响应回显认证字段
- **WHEN** 模型发现接口返回包含 JSON 认证字段或 `Authorization: Basic` 的错误正文
- **THEN** 任务窗格收到的错误只包含脱敏摘要，原始认证值不出现在错误、日志或配置状态中

#### Scenario: 生成接口回显 Bearer 令牌
- **WHEN** 任一生成或流式接口在错误正文中回显当前或其他形式的 Bearer 令牌
- **THEN** 返回的 `RuntimeConfigError` 或 `ProviderError` 不包含该令牌值

### Requirement: Anthropic reasoning block 必须可无损续传
Anthropic Messages 适配器 MUST 在非流式和流式路径保留连续 `thinking` block 的文本、签名和 `redacted_thinking` block，并在工具结果续传时按原顺序原样传回。空文本但具有签名或 redacted 内容的 reasoning block MUST 不得被过滤。

#### Scenario: 流式 thinking 后调用工具
- **WHEN** Anthropic 流在 thinking block 中发送 `thinking_delta` 和 `signature_delta`，随后发送工具调用
- **THEN** 下一轮携带工具结果的请求包含同一 thinking 文本和签名，提供方可继续该工具循环

#### Scenario: 提供方返回 redacted thinking
- **WHEN** Anthropic 完整响应包含 `redacted_thinking` block 和工具调用
- **THEN** 工具续传请求保留该 block 的类型、顺序和内容，而不因缺少普通 thinking 文本丢弃它
