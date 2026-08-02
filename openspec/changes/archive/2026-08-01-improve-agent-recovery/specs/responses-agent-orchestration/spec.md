## MODIFIED Requirements

### Requirement: 验证模型工具调用
系统 MUST 验证模型工具调用的 `call_id`、工具名和参数。具有唯一非空 `call_id` 的未知工具、无法解析的参数 JSON或不符合共享工具 Schema 的参数 MUST NOT 调用任何 Excel 执行器，系统 SHALL 把结构化失败结果与该 `call_id` 对应后自动继续模型循环。缺失或重复 `call_id` 以及不匹配的前端工具结果 MUST 终止并清理会话。

#### Scenario: 模型请求未知工具
- **WHEN** 模型响应包含唯一 `call_id` 但工具名不在共享工具注册表中
- **THEN** 系统不调用 Office.js 或原生 `.xls` 执行器，把 `TOOL_UNKNOWN` 失败结果返回模型并允许模型在步骤上限内改用有效工具

#### Scenario: 模型生成无效范围后自行修正
- **WHEN** 模型使用唯一 `call_id` 调用已知工具，但参数中的地址不符合允许的 A1 范围
- **THEN** 系统不执行该工具，把包含错误代码、消息和参数路径的可恢复结果返回模型，并自动继续下一模型步骤

#### Scenario: 同一步包含有效和无效调用
- **WHEN** 同一个模型步骤包含至少一个参数有效的调用和至少一个具有唯一 `call_id` 的无效调用
- **THEN** 系统只把有效调用交给 Excel 执行器，并在有效结果返回后把全部有效结果和结构化失败结果一并发送给下一模型步骤

#### Scenario: 四种协议携带失败工具结果
- **WHEN** 可恢复失败需要继续 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 或 Google Gemini 工具循环
- **THEN** 协议适配器分别使用 `function_call_output`、`tool` 消息、`tool_result` 或 `functionResponse` 携带同一结构化失败内容

#### Scenario: 模型工具调用缺少关联标识
- **WHEN** 模型工具调用缺少 `call_id` 或同一步包含重复 `call_id`
- **THEN** 系统停止循环并清理会话，不猜测工具结果对应关系

#### Scenario: 自动修正受步骤上限约束
- **WHEN** 模型持续返回可恢复的无效工具调用直到达到当前步骤上限
- **THEN** 系统停止循环、清理会话并返回包含实际配置值的步骤上限错误
