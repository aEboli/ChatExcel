## 1. 规格与恢复边界

- [x] 1.1 完成自主恢复 proposal、增量 specs、design 和 tasks，并运行 `openspec validate improve-agent-recovery --strict --no-interactive`
- [x] 1.2 用单元测试确认缺失或重复 `call_id`、工具结果不匹配和用户取消仍失败关闭

## 2. Agent 自动恢复

- [x] 2.1 重构函数调用解析，区分可执行调用、可恢复模型错误和不可恢复协议错误
- [x] 2.2 在统一会话循环中追加匹配的失败工具结果并自动推进，同时计入当前最大步骤数
- [x] 2.3 更新 Agent 指令，要求在工具失败后自行修正、缩小范围或分块继续

## 3. Excel 范围兼容

- [x] 3.1 扩展共享地址校验和工具说明，支持单元格、矩形、整列、整行及绝对引用
- [x] 3.2 增加合法和非法地址表驱动测试，并确认 Office.js 与原生 `.xls` 仍复用共享校验后执行

## 4. 验证

- [x] 4.1 运行 `npm run check`、`npm test`、`npm run validate:manifest` 和 `npm audit --omit=dev`
- [x] 4.2 运行 `npm run check:launcher`、严格 OpenSpec 验证和 `git diff --check`
- [x] 4.3 使用模拟提供方复现一次无效地址后自动修正成功，确认任务窗格不再显示终止性参数错误
