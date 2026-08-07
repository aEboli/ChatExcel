## Why

当前任务窗格的顶部栏、操作记录、消息气泡和底部输入区仍占用偏多垂直空间，窄窗格下可用于查看对话与工作簿结果的区域不足。需要在不牺牲正文可读性和控件可操作性的前提下，将界面整体收紧一档。

## What Changes

- 缩减任务窗格外层间距、顶部栏、操作记录和底部输入区的非必要高度与内边距。
- 小幅收紧消息气泡、设置页区块和页脚装饰的尺寸，正文保持清晰可读。
- 保持桌面端交互控件至少 24 CSS 像素的点击区域，并保留现有键盘焦点与 reduced-motion 行为。
- 在 400x900 和 320x700 视口验证无横向溢出、文字遮挡或核心控件重叠。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `taskpane-experience`: 增加紧凑布局密度、最低桌面点击区域和窄窗格稳定性的要求。

## Impact

- 主要修改 `src/taskpane/taskpane.css`。
- 更新任务窗格布局测试、视觉截图和 `design-qa.md`。
- 不改变模型协议、Excel 工具、审批语义、恢复数据、API 或依赖；本地令牌仍不进入 Excel WebView，也不包含 Microsoft Marketplace 发布工作。
