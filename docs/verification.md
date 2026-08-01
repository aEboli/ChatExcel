# 验证记录

## 2026-08-01 依赖审计

- `npm audit --omit=dev`：0 个生产依赖漏洞。
- 完整开发依赖树：10 个未解决告警，其中 4 个中危、6 个高危，均位于 Microsoft Office 开发 CLI 及其传递依赖。
- 直接受影响的开发包为 `office-addin-dev-settings` 和 `office-addin-manifest`；相关传递包包括 `@microsoft/kiota`、`@microsoft/teamsfx-core`、`adm-zip`、`office-addin-project`、`@azure/msal-node`、`@microsoft/m365agentstoolkit-cli`、`office-addin-usage-data` 和 `uuid`。
- 未运行 `npm audit fix --force`，因为它会对微软侧载和清单工具进行破坏性主版本替换。这些包不进入本地 HTTPS 服务的生产依赖路径；执行开发 CLI 时仍应把清单和工作目录视为可信输入。
- `office-addin-dev-certs@2.0.10` 自带的 `verify` 在当前 Node.js 24 环境误判有效证书/密钥，进而让 `getHttpsServerOptions()` 重复生成证书。运行时改为只读微软工具生成的证书；`npm run certs:verify` 使用 Node TLS 校验密钥匹配、名称、期限和 Windows 系统信任状态。

## 2026-08-01 Responses 兼容性

- 当前提供方：`Sub2API`。
- 当前模型：`gpt-5.6-sol`。
- 当前接口：本机 `/responses`。
- 已验证 `store: false`、`parallel_tool_calls: false`、严格函数 Schema 和 `reasoning.encrypted_content` 请求。
- 首轮得到 `function_call`，追加完整输出和匹配 `call_id` 的 `function_call_output` 后得到最终 `message`。
- 临时低推理强度测试全流程用时约 22 秒；测试未修改用户配置，也未读取真实工作簿。

## 2026-08-01 Microsoft Excel 桌面冒烟验收

- `npm run sideload` 成功注册 `manifest.xml`，并在独立 Microsoft Excel 进程中打开临时测试工作簿。
- 功能区显示 `ChatEx / 打开 ChatExcel`，任务窗格和设置页均可加载；设置页实际显示最大步骤数默认值和当前值均为 `100`。
- 读取工作簿信息、读取 `Sheet1!A1:C4`、写入 `A1:C4`、写入 `D1` 和写入 `D2` 公式均成功；`=SUM(C2:C4)` 的 Excel 实际计算结果为 `60`。
- 当前自定义模型生成的下一次 `format_range` 调用把 `bold` 传成错误类型，服务返回 `$.bold 的类型不正确。` 并保持失败关闭。格式、表格和图表流程因此没有在本轮全部通过，OpenSpec 的完整 Excel 验收与归档任务继续保持未完成。
- 所有修改均发生在侧载脚本创建的临时测试工作簿中，没有操作用户现有工作簿，也没有把该测试工作簿纳入项目提交。
