## ADDED Requirements

### Requirement: 成功安装后保持加载项服务就绪

ChatExcel SHALL 在当前用户主动完成一次成功的源码安装或 Windows Launcher 旁加载后，为该用户登记登录启动命令。该命令 MUST 只启动或复用既有 ChatExcel 本地服务及监督器，MUST NOT 打开 Excel、重新注册清单，也不得在启动参数、注册表值或日志中传递、写入或暴露模型凭据和工作簿数据。

#### Scenario: 后续登录后从 Excel 打开 ChatExcel

- **WHEN** 用户已成功安装 ChatExcel，随后重新登录 Windows、打开 Excel 并从加载项入口点击 ChatExcel
- **THEN** 既有本地服务已通过版本化回环 HTTPS 健康检查，任务窗格可以加载而无需用户手动运行项目命令

#### Scenario: 安装或旁加载失败

- **WHEN** 依赖、证书、清单、服务健康检查或 Office 旁加载任一步骤失败
- **THEN** 安装流程返回失败，且不得把本次失败目录登记为新的登录启动命令

### Requirement: 启动项限制在当前用户和固定服务入口

启动项管理 MUST 只写入当前用户注册表，MUST 使用固定值名和固定参数。源码安装 SHALL 指向当前项目的 `scripts/start.ps1`；发行 Launcher SHALL 指向当前可执行文件的 `--service-only` 模式。路径参数 MUST 被完整引用，包含空格的路径不得改变命令边界。

#### Scenario: 发行目录包含空格

- **WHEN** Launcher 位于包含空格的发行目录并成功完成默认或现代工作簿启动
- **THEN** 当前用户启动项仍把完整 Launcher 路径解析为单个可执行文件参数，并只附加 `--service-only`

#### Scenario: 登录启动证书已失效

- **WHEN** 登录启动运行时本地 HTTPS 证书缺失或不可信
- **THEN** 服务启动返回失败且不弹出证书信任或其他交互窗口，用户可通过主动运行安装器或 Launcher 修复

### Requirement: 启动竞态不把暂时不可达伪装成配置成功

任务窗格在 Excel 初始化阶段读取本地配置时，SHALL 对短暂的网络连接失败执行有限次数的退避重试。重试 MUST 有固定上限，且不得重试 HTTP 错误、取消或配置校验错误；所有重试耗尽后仍须显示现有失败和修复状态。

#### Scenario: 登录启动服务尚在完成 HTTPS 初始化

- **WHEN** 已登记的登录启动项启动服务后，任务窗格首次请求 `/api/config` 遇到暂时的网络 `TypeError`
- **THEN** 任务窗格按有界退避间隔重试，服务恢复后正常显示配置；若仍失败则保持错误状态，不伪造成功

### Requirement: Office 入口使用服务实际监听的 IPv4 回环地址

Office 清单和原生 `.xls` 伴随窗格 MUST 使用本地服务实际监听且受开发证书覆盖的 `https://127.0.0.1:3210` 地址。它们不得依赖 `localhost` 的 IPv4/IPv6 解析顺序。

#### Scenario: Windows 优先将 localhost 解析为 IPv6

- **WHEN** Windows 将 `localhost` 优先解析为未监听的 `::1`
- **THEN** 用户从 Excel 加载项或原生 `.xls` 伴随窗格打开 ChatExcel 时仍连接到 `127.0.0.1:3210`，任务窗格可以加载

### Requirement: 卸载只移除当前安装拥有的启动项

源码卸载 SHALL 仅在固定启动项的现值与当前项目计算出的完整命令一致时删除该值。若同名值已指向其他 ChatExcel 目录或发行 Launcher，卸载 MUST 保留该值。

#### Scenario: 当前项目拥有启动项

- **WHEN** 用户卸载源码项目且启动项仍精确指向该项目的 `scripts/start.ps1`
- **THEN** 卸载在停止服务和清理项目依赖时删除该启动项

#### Scenario: 其他安装已接管启动项

- **WHEN** 用户卸载源码项目但固定启动项已指向另一个 ChatExcel 目录或发行 Launcher
- **THEN** 卸载不修改该启动项，也不停止或删除未被当前项目进程身份校验拥有的服务
