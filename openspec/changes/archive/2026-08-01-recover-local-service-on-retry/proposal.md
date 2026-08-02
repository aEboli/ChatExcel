## Why

Excel 在任务窗格页面尚未从 `https://localhost:3210` 加载成功时显示的是宿主错误页，页面 JavaScript 无法运行；当前 Node.js 服务如果退出，用户点击该错误页的“重试”不会有任何本地进程负责恢复服务。

## What Changes

- 在项目现有的本地启动流程中启动一个受项目 PID 文件约束的后台服务守护器。
- 守护器在受管 Node.js 服务停止或健康检查持续失败时重新启动服务，并等待既有 HTTPS 健康检查恢复。
- 保持端口和进程所有权边界：端口被其他程序占用时不终止、不接管，并保留可诊断错误。
- 更新显式停止流程，使 `npm run stop:local` 同时停止守护器与服务，避免主动停止后被自动拉起。
- 更新启动器资源检查和中英文运行说明，明确 Excel 错误页“重试”会在本地服务恢复后重新加载。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `local-addin-runtime`: 本地服务在由项目启动后具备受限的自恢复与显式停止语义。

## Impact

- 修改 `scripts/start.ps1`、`scripts/stop.ps1`，新增受项目目录约束的服务守护脚本。
- 修改启动器的发行资源检查，补充服务生命周期测试及中英文 README。
- 不新增网络端点、依赖、遥测或凭据访问；服务仍只监听回环地址，模型令牌仍不进入 Excel WebView。
