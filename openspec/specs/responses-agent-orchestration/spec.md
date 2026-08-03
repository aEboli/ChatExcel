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
系统 MUST 把活动 Agent 会话保存在本机内存中，MUST 将模型步骤限制为最多 12 次，并 SHALL 清理过期或被明确取消的会话。对于用户授权的当前工作簿崩溃恢复，系统 MAY 将不包含凭据的最小会话快照保存到受限的本地加密缓存中；服务重启、任务窗格异常断开和可诊断的提供方终态错误 MUST 保留该缓存以供显式恢复，而用户取消、重置或清空会话 MUST 同时清理内存会话和恢复快照。具备工作簿绑定的恢复会话 MUST 仅以最后一次成功任务窗格存活心跳判断过期，用户或模型活动不得续期；任务窗格持续打开时，即使没有对话也不得将其清理。会话从活动表移除但最终恢复检查点尚未完成时 MUST 保持按会话 ID 可查询的收尾登记；取消或严格清除 MUST 中止该会话、等待其已入队检查点，再清除快照。收尾未完成的会话 ID MUST NOT 被重新开始、恢复或心跳操作复用。

#### Scenario: 超过最大步骤数
- **WHEN** 模型在第 12 个步骤后仍要求继续调用工具
- **THEN** 系统停止循环、清理会话并向任务窗格返回步骤上限错误

#### Scenario: 用户取消任务
- **WHEN** 用户在模型请求或工具确认期间点击停止
- **THEN** 系统中止当前请求、清理会话和恢复快照，并且不执行尚未批准的工具；即使提供方在中止后迟到返回，也不得重新写入或恢复该快照

#### Scenario: 服务正常关闭
- **WHEN** 本地服务在模型请求或工具确认期间收到正常关闭信号
- **THEN** 系统必须先以挂起语义保存恢复检查点，再中止请求和释放内存；后续恢复不得自动重发该请求或执行工具

#### Scenario: 任务窗格异常断开
- **WHEN** 本地 Agent SSE 连接在模型请求或工具确认期间异常断开
- **THEN** 系统中止正在进行的请求、保留加密恢复快照并且不将该断开视为用户取消

#### Scenario: 挂起与显式取消并发
- **WHEN** 异常断开已排队最终检查点，同时用户请求普通取消或严格恢复清除
- **THEN** 系统等待该检查点完成后删除快照，后续不得有该会话的保存操作，且该会话 ID 在收尾完成前不可复用

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
