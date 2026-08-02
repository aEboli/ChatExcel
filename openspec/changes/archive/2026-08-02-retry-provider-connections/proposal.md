## Why

用户切换网络时，正在进行的模型提供方请求会立即被判定为不可用并终止整个 Excel 任务。短暂网络切换不应丢失尚未执行完的任务，且重连过程不得泄露模型令牌或重复执行工作簿操作。

## What Changes

- 为模型提供方的可恢复传输断连增加固定间隔的自动重连：首次连接失败后每 3 秒重试一次，最多重连 10 次。
- 在流式请求中向任务窗格传递重连状态，并撤销断开尝试产生的未完成文字草稿，避免两次模型响应混杂显示。
- 保留用户停止、全局超时、鉴权/其他 HTTP 错误、无效响应和明确的提供方流式错误的立即失败语义；重连耗尽后才返回现有的脱敏连接失败错误。

## Capabilities

### New Capabilities

- `provider-connection-recovery`: 在本地服务和任务窗格之间协调模型提供方传输断连后的有限自动重连。

### Modified Capabilities

<!-- None. Existing provider error handling remains the terminal behavior after retries are exhausted. -->

## Impact

- 受影响代码：`src/server/provider-client.js`、任务窗格的流式事件处理，以及相关 Node.js 单元测试。
- 不增加第三方依赖、不改变本地 HTTPS 回环边界，也不会把 API Key、提示词或工作簿内容写入 Excel WebView 之外的持久化位置。
