## Context

`package.json` 已是 `0.0.4`，构建脚本会把它传给 `dotnet publish`，并据此写入 `release.json` 与 ZIP 文件名。Launcher 项目中的默认程序集版本仍需同步，以确保直接执行 `npm run check:launcher` 时也使用同一版本。

## Decisions

- 使用根 `package.json` 作为发行版本的唯一来源；默认 Launcher 元数据与其保持一致，发布脚本继续以命令行属性覆盖并校验最终 EXE 版本。
- 将解析出的启动请求保留到 `Main` 的异常处理范围，使 `--service-only` 失败时能够无 UI 返回，且不引入新的错误路径。
- 将 ZIP 与同名 `.sha256` 一起发布到不可预发布的 `v0.0.4` GitHub Release。
- 发布前核验 ZIP 内容、哈希、Launcher `--diagnose` 的无副作用行为，以及标签所指提交。

## Security And Distribution Boundaries

- 发行 ZIP 不包含 `.env`、测试、OpenSpec、运行时日志或本机凭据；打包脚本会拒绝这些内容。
- 不将实验性 `native-addin/` 分发为正式功能；桌面 Excel 的长时流式取消、实时工作簿修改和原生 `.xls` 兼容性仍保留人工验收边界。
- 本次只发布 GitHub Windows x64 启动器，不发布到 Microsoft Marketplace。
