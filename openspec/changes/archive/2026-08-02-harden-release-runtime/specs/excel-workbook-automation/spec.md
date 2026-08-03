## ADDED Requirements

### Requirement: 原生 XLS 工具隔离到绑定工作簿
原生 `.xls` 执行器 MUST 只从 Launcher 绑定工作簿的窗口读取选区和活动单元格，只处理该工作簿的 Excel 事件，并且只在该工作簿仍为活动工作簿时调用应用级 Undo。无法保证该边界的操作 MUST 返回可恢复错误而不得读取、修改或撤销另一个打开的工作簿。

#### Scenario: 同一 Excel 实例激活另一工作簿
- **WHEN** 用户在宿主 Excel 实例打开并激活第二个工作簿
- **THEN** 原生 `get_selection` 仍返回绑定 `.xls` 窗口的选区，第二个工作簿的激活和编辑不改变绑定会话 revision

#### Scenario: 另一工作簿成为活动工作簿时请求撤销
- **WHEN** 原生工具请求 Undo 且活动工作簿不是绑定 `.xls`
- **THEN** 执行器返回结构化的不可用错误，第二个工作簿的最近用户操作保持不变

### Requirement: 原生格式和表格失败不得破坏源数据
原生 `.xls` 执行器 MUST 在设置数字格式前计算实际范围尺寸并拒绝超过 5,000 个单元格的范围。混合 `NumberFormat` 读取 MUST 返回逐单元格的准确二维值。在新建表格后的命名或样式配置失败时，执行器 MUST 移除新表对象并保留原范围的值、公式和格式。

#### Scenario: 过大的原生数字格式范围
- **WHEN** 模型请求对超过 5,000 个单元格的范围或整列整行范围设置数字格式
- **THEN** 执行器返回 `NUMBER_FORMAT_RANGE_TOO_LARGE`，且不修改该范围

#### Scenario: 读取混合数字格式
- **WHEN** 原生读取范围中的单元格具有不同数字格式
- **THEN** 返回的二维 `numberFormat` 包含每个单元格的实际格式，而不是整块空值

#### Scenario: 创建表格的后置配置失败
- **WHEN** 新建表格后设置重复名称或无效样式失败
- **THEN** 表格对象被移除，源区域的值、公式和数字格式保持不变

### Requirement: 原生宿主失败和关闭保留正确生命周期
Launcher 打开 `.xls` 失败时 MUST 退出仅为该尝试新建的 Excel 实例并返回非零退出码；WebView2 初始化失败 MUST 传播为 Launcher 非零退出码。绑定工作簿的 `BeforeClose` 事件只有在 Excel 确认该工作簿实际关闭后才释放原生窗格、管道和事件订阅；用户取消关闭时它们 MUST 保持可用。

#### Scenario: 用户取消关闭绑定工作簿
- **WHEN** Excel 的关闭流程被用户或事件处理器取消
- **THEN** 原生窗格和管道保持可用，后续状态请求不会返回 `WORKBOOK_CLOSED`

#### Scenario: WebView2 初始化失败
- **WHEN** 原生窗格无法初始化 WebView2
- **THEN** Launcher 记录 `WebView2` 阶段失败并以非零代码退出，不报告启动成功
