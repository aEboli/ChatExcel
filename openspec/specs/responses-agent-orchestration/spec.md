# Responses Agent 编排规格

## Purpose

定义本地服务通过 Responses API 执行无状态函数工具循环、限制会话并安全呈现提供方错误的行为。
## Requirements
### Requirement: 执行 Responses 函数工具循环
系统 SHALL 使用 Responses API 发送用户输入和共享 Excel 工具定义，MUST 使用 `store: false` 并请求 `reasoning.encrypted_content`，并在每步响应后保存完整 `response.output`，再追加与 `call_id` 对应的 `function_call_output` 继续请求。

#### Scenario: 单个读取工具后生成回答
- **WHEN** 模型先调用一个读取工具且 Excel 返回成功结果
- **THEN** 系统把模型输出项和工具结果加入下一次输入并返回最终文本回答

#### Scenario: 推理模型调用工具
- **WHEN** 响应同时包含推理项和函数调用项
- **THEN** 系统在下一次请求中原样包含这些输出项和对应工具结果

### Requirement: 会话限制和清理
系统 MUST 把 Agent 会话保存在本机内存中，MUST 将模型步骤限制为最多 12 次，并 SHALL 清理过期或被取消的会话。

#### Scenario: 超过最大步骤数
- **WHEN** 模型在第 12 个步骤后仍要求继续调用工具
- **THEN** 系统停止循环、清理会话并向任务窗格返回步骤上限错误

#### Scenario: 用户取消任务
- **WHEN** 用户在模型请求或工具确认期间点击停止
- **THEN** 系统中止当前请求、清理会话并且不执行尚未批准的工具

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

### Requirement: 提供方错误保持可诊断
系统 SHALL 把超时、连接失败和非成功 HTTP 响应转换为不含凭据的错误，并保留安全的状态码和响应摘要。

#### Scenario: 本地提供方不可用
- **WHEN** Responses URL 无法连接
- **THEN** 任务窗格显示提供方不可用，服务日志不包含 Authorization 头或令牌
