## ADDED Requirements

### Requirement: 输入区提供图片附件交互

任务窗格输入区 SHALL 在不产生横向溢出的前提下容纳附件缩略图、删除动作和放大模态层；控件 MUST 提供可读的中文标题、键盘焦点和 reduced-motion 兼容的状态反馈。

#### Scenario: 窄任务窗格显示附件

- **WHEN** 任务窗格宽度为 320 CSS 像素且存在一张或多张待发送图片
- **THEN** 缩略图在输入区内换行或横向滚动，不遮挡文本输入、发送和审批控件

#### Scenario: 减少动效偏好

- **WHEN** 浏览器启用 `prefers-reduced-motion: reduce`
- **THEN** 附件进入和模态层显示不使用持续动画，图片仍可访问、删除和放大
