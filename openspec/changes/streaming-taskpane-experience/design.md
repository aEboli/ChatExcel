## Context

任务窗格需要在模型生成文字时立即给出反馈，但当前本地服务只返回完整 JSON。四种提供方的 SSE 事件形状不同，不能把上游事件直接暴露给 Excel WebView；工具调用参数也必须等到完整后再交给既有的严格 Schema 校验和审批流程。

## Decisions

### 使用任务请求级 SSE，保留 JSON 回退

当任务窗格请求 `Accept: text/event-stream` 时，`/api/sessions`、`/messages` 和 `/tool-results` 返回本地 SSE。服务端把上游的文字增量转成统一的 `text_delta` 事件，把最终的规范化会话结果作为 `result` 事件，最后发送 `done`。非流式客户端继续收到原有 JSON 响应。SSE 只在回环 HTTPS 服务上提供，令牌不会写入事件。

### 按协议累积并在完成时归一化

- OpenAI Responses 使用 `response.output_text.delta` 和函数调用参数增量，优先采用 `response.completed` 中的完整响应。
- OpenAI Chat Completions 累积 `choices[].delta` 的文本、工具调用 ID、名称和参数片段，并重建标准 `choices[].message`。
- Anthropic Messages 累积 `content_block_delta` 的 `text_delta`、`thinking_delta` 和 `input_json_delta`，再重建 `content` 块。
- Gemini 使用 `streamGenerateContent?alt=sse`，累积候选 parts、文本和 `functionCall`，再重建单候选响应。

每种适配器都向同一个回调发出脱敏的 `text_delta`；只有最终响应经过现有归一化逻辑后才进入 SessionManager 的工具校验和上下文计算。上游返回普通 JSON 时直接走原有解析路径。

### 会话回调只绑定当前 HTTP 请求

SessionManager 在每次 `start`、`addMessage` 或 `submitToolResults` 调用时临时绑定事件回调，并在该模型步骤完成后清空。这样下一次工具结果请求不会写入已经结束的响应；客户端断开时取消会话并中止上游 AbortController。

### 最终消息在动作之后收束

任务窗格收到首个 `text_delta` 时创建流式助手草稿，便于在模型生成期间立即展示文字。最终 `assistant_message` 到达时，若草稿创建后已出现新的工作簿动作或自动审批提示，`HistoryState` SHALL 复用该草稿、更新最终文本和时间线索引，并把它移动到消息数组末尾。这样完成说明始终在本次动作之后、贴近输入区，同时不会重复显示一条草稿和一条完成消息。没有后续动作的纯文本回复保持原位；任务失败或停止仍沿用现有的末尾错误反馈。

### 对话气泡和连续动作流

对话区保持 `HistoryState` 的原有消息和时间线索引，不为视觉布局新增持久化状态。`user` 与 `assistant` 消息分别贴右、贴左，最大行内尺寸为可用对话宽度的约三分之二，并使用 18px 的大圆角；窄窗格仍保留最小可读宽度与自动换行。`error` 继续作为左侧告警，不伪装为模型回复。

自动审批产生的 `notice` 消息会在 `renderConversation` 中按可见时间线的相邻段落分组。每个段落渲染成水平居中的 `action-flow`，其中每项是椭圆胶囊；相邻项目之间插入使用现有图标资源的向下箭头。分组仅改变 DOM 包装和样式，不改变消息顺序、内容、历史过滤或顶部操作记录的可点击步骤。因此动作会形成清楚的连续组，历史查看时也不会跨越被过滤的消息错误连接。

### 操作记录以任务为单位分组

HistoryState 新增操作组，但保留现有按工具调用的时间线索引，以便历史上下文保护继续按具体步骤工作。一个 `run_started` 创建操作组，所有工具调用作为组内步骤，`run_finished` 更新组状态。界面组头显示任务摘要、步骤名预览和步数，组内步骤行仍可点击回到对应历史上下文，组默认折叠。

### 单按钮运行状态

发送按钮在空闲时显示箭头；运行时保留同一按钮并切换为旋转圆环。悬停或 `:focus-visible` 显示停止图标，点击调用现有取消流程。按钮运行时不禁用，其他输入控件仍锁定；`prefers-reduced-motion: reduce` 下关闭旋转动画并保留静态状态图标。

## Failure Handling

- SSE 解析失败、上游错误事件、超时或取消均转换为现有脱敏 ProviderError/AgentSessionError。
- 已发送的文字增量不会被伪装成完成消息；只有 `result` 到达后才发布 `assistant_message`。
- 流式草稿在动作完成后必须以最终消息身份重排到对话末尾，不能停留在自动审批提示或操作完成记录之前。
- 连续动作流只连接同一段可见的相邻 `notice`；用户、助手或错误消息会结束该段，避免箭头跨越对话角色或历史边界。
- 工具参数未完整或不符合 Schema 时不执行工具，沿用现有失败关闭行为。
