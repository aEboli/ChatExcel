## Context

当前 `taskpane.html` 只有文本 `textarea`，`taskpane.js` 在输入重构中删除了 `image-attachments.js`、剪贴板监听和附件状态；本地服务的 `session-manager` 与四种协议适配器仍然支持规范化图片附件。Office WebView/Chromium 的剪贴板实现可能把图片放在 `DataTransferItem` 而不是 `clipboardData.files`，因此恢复时必须同时处理两种形态。图片属于任务数据，只能留在当前页面和内存会话中。

## Goals / Non-Goals

**Goals:**

- 粘贴 PNG、JPEG 或 WebP 时，在输入区立即显示稳定尺寸的缩略图，并保留同次粘贴的纯文本。
- 允许键盘和鼠标打开可关闭的放大预览；缩略图和已发送消息中的图片使用同一预览入口。
- 复用现有压缩、数量、类型和大小限制，将规范化附件传给现有 Agent API。
- 避免把图片 data URL 写入设置、恢复快照、日志或工作簿。

**Non-Goals:**

- 不新增上传服务器、外部图片 URL、云端存储或图片编辑能力。
- 不改变服务端四种协议的图片字段映射和既有上限。
- 不在历史恢复展示中持久化或重新显示图片；恢复消息继续只显示文本。

## Decisions

### 以内存附件状态驱动预览

恢复旧版的纯模块化 `prepareImageFile`，使用 `FileReader` 读取剪贴板 `File`，用 `Image` 解码并在必要时用 canvas 压缩到既有上限。组件状态只保留当前待发送附件；DOM 缩略图由该状态重绘，删除不会留下对象 URL 或临时文件。相比把图片直接插入 textarea，独立状态能与服务端 `attachments` 字段一致，也能在发送前校验数量。

### 同时读取 `files` 和 `items`

粘贴事件先从 `clipboardData.files` 收集文件，再从 `clipboardData.items` 对 `kind === "file"` 的条目调用 `getAsFile()`，按对象/类型/大小去重。只有发现受支持图片时才阻止默认粘贴；这样文本粘贴行为不变，并覆盖 Excel WebView 中常见的 `files` 为空场景。

### 使用显式图片预览模态层

缩略图和消息图片使用可聚焦的按钮触发一个任务窗格内的 `role="dialog"` 模态层。模态层只显示当前内存 data URL，提供明确关闭按钮、Escape 和背景点击关闭，并在打开/关闭时管理焦点。使用现有本地图标和 CSS，不依赖浏览器新 API 或外部脚本。

### 图片会话不进入恢复快照

服务端继续在内存 `session.input` 中保留图片以完成当前模型循环，但 checkpoint 前检测 `input_image`。只要会话包含图片，就跳过磁盘恢复写入并发出已有 `recovery_unavailable` 状态；任务窗格保持打开时仍可继续，关闭/崩溃后不恢复该图片任务。这样不把大 data URL 写入 DPAPI 快照，也不伪造缺失图片的可恢复上下文。

## Risks / Trade-offs

- [剪贴板图片格式或编码异常] → 只接受明确的 PNG/JPEG/WebP MIME，解码或压缩失败显示可读错误且不加入附件。
- [图片 data URL 增加请求体和上下文占用] → 复用单图 1.5 MB、总数 4 和服务端总量限制；预览使用固定尺寸避免布局跳动。
- [模态层遮挡输入区或焦点丢失] → 使用固定覆盖层、明确关闭动作、Escape 和打开前焦点回收，并补窄视口契约测试。
- [恢复能力对图片会话下降] → 只在检测到图片时关闭该会话的磁盘恢复，并在界面显示已有恢复不可用状态，不影响当前内存会话。

## Migration Plan

1. 恢复前端附件模块、输入区标记、缩略图样式和放大模态层；修复 Agent API 将附件传入服务。
2. 在服务 checkpoint 边界拒绝持久化含图片的会话，并补充单元/静态契约测试。
3. 运行 `npm run check`、`npm test`、`npm run validate:manifest`、严格 OpenSpec 校验；构建后在预览视口验证粘贴、删除、放大和发送。
4. 回滚时移除新变更目录及前端附件入口即可，不影响已有文本会话或服务端协议。

## Open Questions

- 当前范围不要求把图片带入恢复后的历史展示；如后续需要，应单独设计加密附件缓存和生命周期，而不是扩大本次快照边界。
