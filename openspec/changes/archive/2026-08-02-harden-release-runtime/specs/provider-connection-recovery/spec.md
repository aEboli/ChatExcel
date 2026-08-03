## ADDED Requirements

### Requirement: 完整提供方响应必须通过协议校验
服务 MUST 在将任何 HTTP 200 非流式响应或流式终态交给会话编排前验证当前协议所需的根字段、候选或内容块及工具调用结构。缺少可归一化终态、空候选或结构不匹配时 MUST 返回 `PROVIDER_RESPONSE_INVALID`，不得把它转换为空助手消息，也不得将该完整无效响应作为可恢复传输错误重连。

#### Scenario: Anthropic 或 Gemini 返回畸形成功 JSON
- **WHEN** 提供方返回 HTTP 200 但正文仅包含无协议语义的对象，例如 `{ "status": "ok" }`
- **THEN** 会话以 `PROVIDER_RESPONSE_INVALID` 失败关闭，既不发送空助手消息也不进入工具执行

#### Scenario: 流式终态缺少必需内容
- **WHEN** SSE 流正常结束但无法构造当前协议的有效最终响应
- **THEN** 服务发送脱敏的协议无效错误，而不是把已累积的部分文本标记为成功完成
