## ADDED Requirements

### Requirement: 支持多协议增量输出
本地服务 SHALL 在请求方选择事件流时，为 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 和 Google Gemini generateContent 提供统一的文字增量事件；每个模型步骤完成后 MUST 发送与既有 JSON API 等价的规范化结果。

#### Scenario: 长文本在完成前显示
- **WHEN** 任一支持的提供方返回多个文本增量
- **THEN** 任务窗格按顺序显示每个增量，并在最终结果到达后只保留一份完整助手消息

#### Scenario: 流式工具调用等待完整参数
- **WHEN** 提供方分片返回工具名称或参数
- **THEN** 系统累积到完整响应后再进行工具 Schema 校验和审批，不执行中间片段

### Requirement: 流式与非流式结果一致
系统 SHALL 在上游返回普通 JSON、SSE 解析失败、超时或取消时沿用现有错误和归一化契约；流式输出不得泄露 API Key 或原始认证头。

#### Scenario: 非流式网关回退
- **WHEN** 用户选择流式请求但网关返回合法的普通 JSON
- **THEN** 服务解析完整 JSON 并返回与非流式调用相同的工具调用、usage 和最终文本

#### Scenario: 用户停止流式请求
- **WHEN** 用户在文字增量到达期间点击停止
- **THEN** 服务中止上游请求、清理 Agent 会话且不执行尚未完成或尚未批准的工具
