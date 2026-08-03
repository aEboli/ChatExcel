## Why

会话异常挂起与用户显式停止并发时，最终恢复检查点可能在删除完成后重新写入快照，导致已经停止的会话下次仍可被恢复。另存为后继续发送消息也没有把最新稳定工作簿绑定传到服务端，恢复缓存可能继续关联旧工作簿。

## What Changes

- 为挂起后仍在执行最终检查点的会话保留受控的收尾登记，使普通取消和严格恢复清除都能中止、等待并清除同一会话，禁止任何迟到检查点复活快照。
- 阻止会话 ID 在收尾未完成期间被复用，并使恢复和心跳不会观察到未完成的收尾状态。
- 将后续消息携带的稳定工作簿绑定传递到 `SessionManager`，在另存为后以新绑定覆盖恢复快照，而不继续写入旧绑定。
- 修复恢复文件锁在释放与陈旧锁回收竞争时可能遗留永久活动锁的窗口，使锁释放在短暂争用后有界重试而不静默放弃，并安全迁移已退出旧进程遗留的主锁或 `.reclaim` 文件锁。
- 为上述并发和绑定迁移路径添加固定时序回归测试。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `local-conversation-recovery`: 明确取消、挂起收尾和工作簿另存为期间的恢复快照一致性。
- `responses-agent-orchestration`: 明确已取消会话的迟到检查点不得重建恢复状态。

## Impact

- 受影响代码：`src/server/session-manager.js`、`src/server/http-app.js`、`src/server/conversation-recovery-store.js` 及其 Node.js 测试。
- 不新增第三方依赖，不改变 Excel WebView 的令牌边界、回环服务边界或公开恢复 API 的路径。
