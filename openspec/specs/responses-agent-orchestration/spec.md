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
系统 MUST 拒绝未知工具、缺失 `call_id`、无法解析的参数 JSON 和不匹配的工具结果。

#### Scenario: 模型请求未知工具
- **WHEN** 模型响应包含不在共享工具注册表中的工具名
- **THEN** 系统返回协议错误且不调用任何 Office.js API

### Requirement: 提供方错误保持可诊断
系统 SHALL 把超时、连接失败和非成功 HTTP 响应转换为不含凭据的错误，并保留安全的状态码和响应摘要。

#### Scenario: 本地提供方不可用
- **WHEN** Responses URL 无法连接
- **THEN** 任务窗格显示提供方不可用，服务日志不包含 Authorization 头或令牌
