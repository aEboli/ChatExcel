## Context

现有任务窗格直接调用 `Excel.run()`，因此无法在 `.xls` 中启动。模型编排、审批和界面并不依赖 Office.js，真正与宿主绑定的是工作簿身份、事件订阅、撤销和 13 个 Excel 工具执行器。

Launcher 已经负责证书、回环服务和 Excel 侧载，适合作为格式路由和原生执行器宿主。发行版为自包含 .NET 8 Windows x64 可执行文件，本机已要求安装 Microsoft Excel 桌面版。

## Decisions

### 使用双工作簿适配器而不是格式转换

任务窗格增加统一的工作簿适配器：

1. 普通 Office 任务窗格使用现有 `excel-executor.js`。
2. URL 带有合法的一次性 `legacy` 会话标识时，使用本地原生桥执行工具、读取身份和撤销。
3. 模型会话、配置、附件、审批、操作记录和历史状态不分叉。

Launcher 的文件路由为：

- 无参数：生成现有侧载工作簿。
- `.xlsx`、`.xlsm`、`.xlsb`：注册清单并由 Microsoft Excel 打开指定文件。
- `.xls`：不注册或注入 Office 加载项，创建专用 Excel COM 实例打开原文件，并显示原生伴随窗格。
- 其他扩展名、目录、不存在文件或多个路径：失败关闭。

### 在 Launcher 内嵌 WebView2 复用任务窗格

`.xls` 模式使用 `Microsoft.Web.WebView2` WinForms 控件显示 `https://localhost:3210/taskpane.html?legacy=<session>`。窗口由 Excel 主窗口拥有并定位在其右侧，关闭窗格不会关闭、保存或丢弃工作簿。Excel 工作簿关闭时窗格同步退出。

WebView2 创建独立的用户级数据目录。页面仍由现有受信任本地证书和 CSP 提供；响应使用 `Referrer-Policy: no-referrer`，一次性会话标识不会发送给 Office.js CDN 或模型提供方。

### 原生 COM 执行器保持 Excel 行为

原生执行器在 STA UI 线程拥有 Excel COM 对象。工作簿使用 `UpdateLinks=0` 和强制禁用自动化宏打开，避免 Launcher 自动执行外链更新或 VBA；用户之后仍可在 Excel 的安全界面自行处理受信任内容。

工具参数先在 Node 服务中复用 `parseAndValidateToolArguments` 校验，再通过白名单命令进入 COM 执行器。修改直接作用于已打开的 `.xls` 内存工作簿，但执行器不调用 `SaveAs`、不改变 `FileFormat`，也不替用户自动保存。只读工作簿拒绝修改工具。

COM 执行器提供与 Office.js 相同的结果形状。批量值和公式在尺寸验证通过后一次赋值；会产生多个 COM 步骤的表格、图表和排序操作在失败时清理本次创建的对象，避免已知部分结果。

### 使用当前用户专用命名管道

每个 `.xls` 会话生成高熵十六进制标识，对应 `ChatExcel-Legacy-<session>` 命名管道。管道使用 `PipeOptions.CurrentUserOnly`，每个连接只处理一条有大小上限的 JSON 请求。Node 端设置连接、响应和消息大小限制。

HTTP 端点仍要求受信任 `Origin`，且会话标识必须满足固定格式。服务不扫描进程、不枚举工作簿，也不持久化会话。Launcher 结束或窗格关闭后管道立即消失。

### 通过 Excel 事件延续历史保护

原生宿主订阅 `SheetChange` 和 `SheetActivate`。工具执行期间抑制自身修改事件；其他更改增加手动修订号。任务窗格轮询轻量状态，在历史操作上下文检测到修订变化时复用现有确认框；取消时调用 Excel 原生 `Undo`，确认时回到最新对话。

## Risks / Trade-offs

- 原生伴随窗格由 Excel 拥有并贴靠窗口，但不是微软 Office.js Custom Task Pane；这是在不安装机器级 COM Add-in 的情况下保持一键发行和同界面的折中。
- WebView2 Runtime 是原生界面的运行条件。现代 Office 通常已安装该运行时；缺失时 Launcher 显示明确错误，不回退到不受支持的浏览器。
- `.xls` 兼容模式对表格、图表样式、最大行列等能力有限。执行器遵循当前工作簿实际能力并返回错误，不把文件升级为 OOXML。
- Excel COM 调用必须串行在 STA 线程执行；管道请求按顺序处理，避免跨线程访问 RCW。

## Validation Strategy

- 单元测试覆盖格式路由、会话标识、命名管道消息边界、HTTP 原生端点和任务窗格适配器分流。
- Launcher 构建与发行打包验证 WebView2 和 Excel Interop 依赖被包含。
- 真实 Excel 冒烟测试创建 `.xls` 样本，记录源路径和格式，使用 Launcher 打开后执行读取与写入，保存并重开确认值，同时确认没有 `.xlsx/.xlsm` 副本。
- 运行项目 JavaScript 检查、全套测试、manifest 校验、Launcher 构建、依赖审计、严格 OpenSpec 校验和 `git diff --check`。
