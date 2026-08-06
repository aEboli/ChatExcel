## 1. 附件规范化模块

- [x] 1.1 恢复 `src/taskpane/image-attachments.js`，实现 PNG/JPEG/WebP 校验、FileReader 解码、尺寸/质量压缩、字节计算和受限错误。
- [x] 1.2 补充附件模块单元测试，覆盖 data URL 字节数、格式/大小边界和压缩结果元数据。

## 2. 任务窗格输入与预览

- [x] 2.1 在任务窗格输入区加入附件列表和可访问的图片预览模态层，保持 320px 窄视口无横向溢出。
- [x] 2.2 接线 `clipboardData.files` 与 `clipboardData.items[].getAsFile()`，保留粘贴文本，显示/删除缩略图并允许图片或图片消息点击放大、Escape/背景/关闭按钮退出。
- [x] 2.3 将待发送附件传入 `AgentRunner` 的 start/addMessage 请求，允许仅图片任务发送；发送失败时恢复输入状态，不写入浏览器存储。
- [x] 2.4 扩展 `HistoryState` 和消息渲染，使当前内存对话显示图片而恢复展示只保留文本；补充 reduced-motion 和键盘焦点语义。

## 3. 恢复与服务边界

- [x] 3.1 在 SessionManager checkpoint 前检测 `input_image`，含图片会话跳过恢复存储并发送已有恢复不可用事件，保持内存循环可继续。
- [x] 3.2 补充 AgentRunner/SessionManager/HTTP 回归测试，确认图片字段传递、图片-only 请求和含图片 checkpoint 不落盘。

## 4. 验证与工件同步

- [x] 4.1 更新任务窗格布局契约测试和必要的主规格 delta 说明，检查中文编码与静态资源路径。
- [x] 4.2 运行 `npm run check`、`npm test`、`npm run validate:manifest`、`openspec validate --all --strict`，并在 320x700 与 400x900 预览视口人工复核粘贴、删除、放大、发送和无溢出。
