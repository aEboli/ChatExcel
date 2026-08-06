# Clipboard Image Input Specification

## Purpose

定义 ChatExcel 任务窗格接收剪贴板图片、在当前内存中预览与发送，并避免将图片附件持久化的行为。

## Requirements

### Requirement: 接收并预览剪贴板图片

任务窗格 MUST 在聚焦输入框时接收剪贴板中的 PNG、JPEG 或 WebP 图片；实现 MUST 同时支持 `clipboardData.files` 和 `DataTransferItem.getAsFile()`，并 SHALL 在当前输入区显示每张已验证图片的固定尺寸缩略图。图片附件只保存在当前页面内存中。

#### Scenario: 粘贴图片和文字

- **WHEN** 用户把包含一张受支持图片和纯文本的剪贴板内容粘贴到输入框
- **THEN** 输入框保留文本，附件区立即显示图片缩略图，且发送控件可用

#### Scenario: WebView 只提供 clipboard items

- **WHEN** `clipboardData.files` 为空但 `clipboardData.items` 包含 `kind="file"` 的 PNG、JPEG 或 WebP
- **THEN** 任务窗格通过 `getAsFile()` 接收该图片并显示同样的缩略图

#### Scenario: 不支持的剪贴板内容

- **WHEN** 粘贴内容只有文本，或图片 MIME 不是 PNG、JPEG、WebP
- **THEN** 文本按浏览器默认行为粘贴，不新增附件；不支持的图片显示明确错误且不进入发送列表

### Requirement: 限制和删除待发送图片

任务窗格 MUST 复用既有单图、总数、原图和压缩后大小限制；用户 MUST 能逐张删除待发送图片，删除后不能再把该图片发送到本地服务。

#### Scenario: 达到附件数量上限

- **WHEN** 当前待发送附件数量已经达到四张，用户再次粘贴图片
- **THEN** 任务窗格显示数量错误，不改变已有附件列表

#### Scenario: 删除附件

- **WHEN** 用户点击某张缩略图的删除按钮
- **THEN** 该缩略图从附件区移除，若没有文本或其他附件则发送控件变为不可用

### Requirement: 点击图片打开可关闭的放大预览

待发送缩略图和已发送消息中的图片 MUST 是可聚焦的图片触发器；点击或键盘确认后 MUST 打开任务窗格内的放大预览。预览 MUST 提供关闭按钮、Escape 和背景点击关闭，并恢复打开前的焦点。

#### Scenario: 放大待发送图片

- **WHEN** 用户点击或键盘确认一张待发送缩略图
- **THEN** 模态预览显示同一 data URL 的完整可缩放图片，关闭按钮获得焦点，输入区不被修改

#### Scenario: 关闭放大预览

- **WHEN** 用户点击关闭按钮、按 Escape 或点击预览背景
- **THEN** 模态预览隐藏并把焦点返回触发器

### Requirement: 发送图片附件且不持久化

发送任务 MUST 将待发送图片以既有 `attachments` 字段传给本地 Agent API；图片 MUST NOT 写入设置、日志、工作簿或本地恢复快照。含图片的会话在任务窗格仍打开时可继续，但服务 MUST 跳过该会话的磁盘恢复 checkpoint 并报告恢复不可用。

#### Scenario: 图片随任务发送

- **WHEN** 用户提交带文本或仅带图片的任务
- **THEN** Agent API 请求包含规范化图片 data URL，服务端继续执行既有 MIME、数量和大小校验

#### Scenario: 图片会话 checkpoint

- **WHEN** 服务准备持久化一个 `session.input` 含 `input_image` 的恢复快照
- **THEN** 服务不写入恢复存储，并向当前任务窗格报告恢复不可用状态
