## Why

`set_number_format` 需要向 Office.js 的 `Range.numberFormat` 传入二维数组。当前实现允许整列和整行 A1 地址，却会按工作表实际尺寸构造完整矩阵，单列可分配超过一百万个数组，可能使任务窗格失去响应或耗尽内存。

## What Changes

- 为数字格式执行增加独立的最大单元格限制，并在创建二维格式矩阵前验证实际范围尺寸。
- 对超限的数字格式请求返回结构化、可恢复的错误，提示 Agent 缩小或分块执行，且不修改工作簿。
- 在工具说明和自动化测试中明确数字格式的范围限制；整列和整行仍可用于不需要二维值矩阵的格式和自动调整工具。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `excel-workbook-automation`: 数字格式修改必须在安全单元格上限内执行，并在超限时失败关闭。

## Impact

- 修改共享工具说明、Office.js 数字格式执行器和执行器测试。
- 不改变网络接口、模型凭据边界、审批模式或原生 `.xls` 执行路径。
