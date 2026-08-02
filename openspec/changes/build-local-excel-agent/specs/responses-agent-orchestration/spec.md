## ADDED Requirements

### Requirement: 执行统一函数工具循环
系统 SHALL 通过协议适配层发送用户输入和共享 Excel 工具定义，支持 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 和 Google Gemini generateContent。Responses 请求 MUST 使用 `store: false` 并请求 `reasoning.encrypted_content`；其他协议 MUST 使用各自的无服务端消息历史和工具结果格式。每步响应 MUST 归一化为包含文字、稳定调用 ID、工具名、参数和 usage 的内部输出，再追加与调用 ID 对应的工具结果继续请求。

#### Scenario: 四种协议完成单个读取工具
- **WHEN** OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 或 Gemini 先调用一个读取工具且 Excel 返回成功结果
- **THEN** 对应适配器把模型输出项和工具结果加入下一次输入并返回同一规范化的最终文本回答

#### Scenario: 推理模型调用工具
- **WHEN** Responses 响应同时包含推理项和函数调用项，或其他协议返回思考内容和函数调用项
- **THEN** 系统在下一次请求中保留协议所需的思考状态或安全忽略不可回放内容，并包含对应工具结果

### Requirement: 会话限制和清理
系统 MUST 把 Agent 会话保存在本机内存中，MUST 默认将模型步骤限制为最多 100 次，SHALL 允许用户在 1 到 1000 范围内配置上限，并 SHALL 清理达到上限、过期或被取消的会话。步骤上限错误 MUST 包含当前实际配置值。

#### Scenario: 超过最大步骤数
- **WHEN** 当前步骤上限为 100 且模型在第 100 个步骤后仍要求继续调用工具
- **THEN** 系统停止循环、清理会话并向任务窗格返回“已达到 100 个模型步骤上限”的错误

#### Scenario: 使用自定义步骤上限
- **WHEN** 用户把最大步骤数保存为 250 后开始新的 Agent 任务
- **THEN** 服务允许该任务最多执行 250 个模型步骤，并在达到该值时返回包含 250 的上限错误

#### Scenario: 用户取消任务
- **WHEN** 用户在模型请求或工具确认期间点击停止
- **THEN** 系统中止当前请求、清理会话并且不执行尚未批准的工具

### Requirement: 验证模型工具调用
系统 MUST 验证模型工具调用的 `call_id`、工具名和参数。具有唯一非空 `call_id` 的未知工具、无法解析的参数 JSON 或不符合共享工具 Schema 的参数 MUST NOT 调用任何 Excel 执行器，系统 SHALL 把结构化失败结果与该 `call_id` 对应后通过当前协议自动继续模型循环。缺失或重复 `call_id` 以及不匹配的前端工具结果 MUST 终止并清理会话。

#### Scenario: 模型请求未知工具后自行修正
- **WHEN** 模型响应包含唯一 `call_id` 但工具名不在共享工具注册表中
- **THEN** 系统不调用 Office.js 或原生 `.xls` 执行器，把 `TOOL_UNKNOWN` 失败结果返回模型并允许模型在步骤上限内改用有效工具

#### Scenario: 模型生成无效参数后自行修正
- **WHEN** 模型使用唯一 `call_id` 调用已知工具，但参数 JSON 或参数内容不符合共享工具 Schema
- **THEN** 系统不执行该调用，把包含错误代码、消息和参数路径的可恢复结果返回模型，并自动继续下一模型步骤

#### Scenario: 同一步包含有效和无效调用
- **WHEN** 同一个模型步骤同时包含参数有效和参数无效的调用
- **THEN** 系统只执行有效调用，并在下一模型步骤同时携带有效结果和无效调用的结构化失败结果

#### Scenario: 模型工具调用缺少关联标识
- **WHEN** 模型工具调用缺少 `call_id`、同一步包含重复 `call_id` 或前端工具结果不匹配
- **THEN** 系统停止循环并清理会话，不猜测工具结果对应关系

### Requirement: 提供方错误保持可诊断
系统 SHALL 把超时、连接失败和非成功 HTTP 响应转换为不含凭据的错误，并保留安全的状态码和响应摘要。

#### Scenario: 本地提供方不可用
- **WHEN** Responses URL 无法连接
- **THEN** 任务窗格显示提供方不可用，服务日志不包含 Authorization 头或令牌

### Requirement: 保留多协议图片输入兼容
系统 SHALL 为受信任的本地客户端接受最多四张 PNG、JPEG 或 WebP 图片作为用户消息附件，MUST 验证数据 URL、单图大小和总大小，并 SHALL 由协议适配器转换为对应的图片内容且不写入磁盘。任务窗格不提供图片附件入口。

#### Scenario: 受信任客户端发送带标注图片的任务
- **WHEN** 受信任本地客户端提交有效图片和带文字的工作簿任务
- **THEN** 模型请求包含对应 `input_text` 和 `input_image` 内容

#### Scenario: 图片超限
- **WHEN** 附件数量、格式或大小超过限制
- **THEN** 系统拒绝请求且不调用模型提供方

#### Scenario: 图片按协议转换
- **WHEN** 用户发送有效图片到 Chat Completions、Anthropic Messages 或 Gemini
- **THEN** 适配器分别发送 `image_url`、base64 image source 或 `inlineData`，不把图片写入磁盘

### Requirement: 回传上下文占用
系统 SHALL 使用提供方返回的 token usage 和当前上下文长度计算脱敏占用比例；当 usage 缺失时 MUST 返回未知状态而不是伪造数值。

#### Scenario: 提供方返回 usage
- **WHEN** 模型响应包含输入和输出 token 用量且配置包含上下文长度
- **THEN** 每个 Agent 响应携带当前使用量、上限和百分比供任务窗格显示

### Requirement: 应用消息级模型选择
系统 SHALL 验证任务窗格提交的模型 ID 和思考等级，并 SHALL 在该用户消息以及后续工具步骤中保持相同选择。

#### Scenario: 用户切换模型和思考等级
- **WHEN** 用户在空闲状态选择可用模型和受支持思考等级后发送消息
- **THEN** 当前消息及其工具循环使用该选择，后续新消息可再次切换
