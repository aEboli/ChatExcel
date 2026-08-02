## Why

当前服务把模型生成的未知工具、无效参数 JSON 和范围格式错误当作不可恢复协议故障，立即清理会话并终止整项任务。实际使用中这类错误通常可以由模型根据结构化反馈自行修正；直接终止使长任务在已完成多步后因一次小偏差卡住。

## What Changes

- 把具有稳定 `call_id` 的未知工具、参数 JSON 和参数 Schema 错误转换为不执行工作簿操作的结构化工具失败结果，并自动继续模型循环。
- 保留缺失或重复 `call_id`、工具结果不匹配、用户取消、步骤上限和安全边界错误的硬停止行为。
- 接受 Excel 常见的单元格、矩形、整列和整行 A1 地址，例如 `A1`、`A1:D20`、`N:R` 和 `1:3`。
- 在 Agent 指令中明确要求根据工具失败结果自行修正、缩小范围或分块继续，不把一次工具失败当成任务结束。
- 本地令牌继续只存在于 Node.js 服务内存，恢复结果不包含凭据，也不进入 Excel WebView 的配置数据。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `responses-agent-orchestration`: 将可关联的模型工具调用错误从终止会话改为结构化反馈并自动继续，同时保留不可关联协议错误的失败关闭。
- `excel-workbook-automation`: 扩展合法 A1 范围形式，并明确参数或执行失败不产生部分写入但允许 Agent 继续修正。

## Impact

- 修改 `src/server/session-manager.js` 的函数调用解析和模型推进循环。
- 修改 `src/shared/excel-tools.js` 的地址说明与语义校验。
- 更新模型系统指令以及会话管理、工具参数测试。
- 不新增依赖，不改变回环来源限制、审批模式、DPAPI 配置保护或 Office.js/原生 `.xls` 执行边界，也不涉及 Microsoft Marketplace 发布。
