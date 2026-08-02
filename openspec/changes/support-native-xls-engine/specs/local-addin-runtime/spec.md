## ADDED Requirements

### Requirement: Launcher 按工作簿格式自动选择执行引擎

Launcher SHALL 在收到一个本地工作簿路径时根据最终扩展名选择执行引擎：`.xls` 使用原生 Excel 引擎，`.xlsx`、`.xlsm` 和 `.xlsb` 使用 Office.js 侧载；无路径时 SHALL 保持默认侧载行为。

#### Scenario: 打开 Excel 97-2003 工作簿

- **WHEN** 用户把一个现有 `.xls` 文件拖到 Launcher 或以该路径启动 Launcher
- **THEN** Launcher 使用 Microsoft Excel 打开原文件并显示原生 ChatEx 窗格，不生成转换副本也不启动该文件的 Office.js 任务窗格

#### Scenario: 打开现代工作簿

- **WHEN** 用户把 `.xlsx`、`.xlsm` 或 `.xlsb` 文件传给 Launcher
- **THEN** Launcher 注册现有清单并使用 Microsoft Excel 打开该文件，工作簿操作继续由 Office.js 执行

#### Scenario: 拒绝不支持的输入

- **WHEN** 输入不存在、不是文件、扩展名不受支持或同时包含多个路径
- **THEN** Launcher 在启动工作簿引擎前失败关闭并显示可操作提示

### Requirement: 原生窗格保持本地会话边界

原生 `.xls` 模式 MUST 使用当前 Windows 用户专用且不可预测的会话管道，MUST 只接受既有 Excel 工具白名单，MUST NOT 在日志中记录会话标识、工作簿路径、提示词或工作簿内容。

#### Scenario: 非任务窗格来源调用原生工具

- **WHEN** 不受信任网页、格式错误的会话标识或不存在的管道请求原生工作簿操作
- **THEN** 回环服务拒绝请求且不枚举或修改任何已打开工作簿

#### Scenario: 关闭原生窗格

- **WHEN** 用户关闭 ChatEx 原生窗格
- **THEN** 会话管道和 COM 事件订阅被释放，而 Excel 和未保存的 `.xls` 工作簿继续由用户控制
