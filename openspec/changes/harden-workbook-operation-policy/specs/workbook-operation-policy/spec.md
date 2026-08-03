## ADDED Requirements

### Requirement: 范围型修改遵循统一影响限制

ChatExcel SHALL 在 Office.js 与原生 `.xls` 引擎对每个范围型修改先读取实际目标尺寸。值、公式、范围格式、数字格式、清除、排序、创建表格和图表源范围 MUST 拒绝超过 5,000 个单元格的目标；自动调整 MUST 按实际请求的行数或列数分别拒绝超过 5,000 个维度的目标。数字格式超限 MUST 保持 `NUMBER_FORMAT_RANGE_TOO_LARGE`，其他单元格范围超限 MUST 返回 `MODIFY_RANGE_TOO_LARGE`，自动调整超限 MUST 返回 `AUTOFIT_TARGET_TOO_LARGE`。

#### Scenario: 拒绝超大范围格式
- **WHEN** 模型请求对实际包含超过 5,000 个单元格的范围设置样式、清除内容、排序、创建表格或创建图表
- **THEN** 执行器在修改前返回 `MODIFY_RANGE_TOO_LARGE`，不修改工作簿，Agent 可以缩小或分块重试

#### Scenario: 保留安全整列自动调整
- **WHEN** 模型请求对 `N:R` 自动调整列宽且只请求列宽
- **THEN** 执行器按 5 个目标列而非整列理论单元格数评估，允许操作并返回实际目标信息

#### Scenario: 拒绝过宽行范围自动调整列宽
- **WHEN** 模型请求对 `1:1` 自动调整列宽
- **THEN** 执行器发现请求会调整超过 5,000 列并返回 `AUTOFIT_TARGET_TOO_LARGE`，不修改工作簿

### Requirement: 修改结果包含预检与写后验证摘要

每个成功的范围型修改 SHALL 返回 `impact` 和 `verification`。`impact` MUST 包含实际目标、行数、列数和适用的单元格或维度数量，并在可安全读取时报告非空单元格、公式单元格和公式错误计数。`verification` MUST 基于修改后的范围读回或创建对象确认，说明执行器实际核验的属性。验证读取或对象确认失败时，执行器 MUST 返回结构化失败结果而不得报告 `ok: true`。

#### Scenario: 写入值后读回验证
- **WHEN** 模型写入尺寸正确且不超过上限的二维值数组
- **THEN** 执行器写入一次后读回目标范围，并在成功结果中返回匹配结果和影响摘要

#### Scenario: 写入公式出现错误值
- **WHEN** 模型写入公式后目标范围包含 Excel 公式错误值
- **THEN** 执行器返回成功的写入和公式错误计数，Agent 在最终声明完成前继续修复或如实报告该错误

#### Scenario: 写后验证读取失败
- **WHEN** Excel 接受修改但执行器无法读取修改后的范围或创建对象
- **THEN** 工具结果为结构化失败而不是 `ok: true`，且不声称工作簿已验证完成

### Requirement: Agent 遵循工作簿质量规则

Agent MUST 在可计算的结果中优先写入 Excel 公式而非静态派生值，先读取目标范围再修改，避免覆盖未被用户指明的内容，并在任务完成前处理或如实报告工具结果中的公式错误和验证失败。该质量规则 MUST NOT 改变用户选择的审批模式。

#### Scenario: 公式任务的完成前检查
- **WHEN** Agent 已完成包含公式写入的多步任务
- **THEN** Agent 检查工具结果中的公式错误和验证摘要，并且只有在错误被修复或明确报告后才声称任务完成
