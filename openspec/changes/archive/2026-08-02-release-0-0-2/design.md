## Context

`v0.0.1` 已经是不可变的 GitHub Release，并且当前 `main` 在该标签之后只包含其发布任务完成记录。工作区中的新功能、测试和双语文档尚未提交。版本号目前分别出现在 npm 元数据、服务健康接口、Launcher 项目、发行脚本和下载链接中，任何遗漏都会使 ZIP、标签和用户可见文档不一致。

## Goals / Non-Goals

**Goals:**

- 以 `0.0.2` 作为唯一的本次发行标识，确保 npm、健康接口、Launcher、`release.json`、ZIP 文件名、Git 标签和 GitHub Release 一致。
- 用双语 README 和更新日志说明本次新增的恢复、服务恢复、工具纠错、历史预览和 `.xls` 路由能力及其实际限制。
- 为 Windows x64 Launcher 生成 ZIP 和 SHA-256 文件，并在发布前后验证内容和远端状态。

**Non-Goals:**

- 不重写或移动 `v0.0.1` 标签、Release 或资产。
- 不新增网络端点、云服务、遥测、依赖或凭据持久化。
- 不将本地 `bin/`、`obj/`、`dist/`、工作簿、日志或机密文件提交到 GitHub。

## Decisions

### 使用补丁版本而非重用已发布标签

GitHub 已存在带资产的 `v0.0.1` Release，因此本次使用 `v0.0.2`。这是唯一能够保留可追溯发布历史并让用户下载到与源码匹配资产的方式；强制移动旧标签会破坏已下载的校验结果和 GitHub Release 语义。

### 发行脚本从 npm 元数据读取版本

`scripts/build-launcher.ps1` 和 `scripts/package-release.ps1` 读取根 `package.json` 版本以生成 `release.json`、ZIP 和 SHA-256 名称。服务常量和 Launcher 项目版本仍在同一次发布修改中显式与该值同步，并由诊断与包检查确认。这样避免每个脚本保留一份过期的硬编码版本。

### 使用更新日志作为 Release 正文来源

双语 `CHANGELOG` 各新增一个 `0.0.2` 条目。GitHub Release 使用英文更新日志条目，确保 GitHub 的默认受众可直接阅读；中文 README 继续链接中文更新日志。两者都只陈述已验证的行为，并保留桌面 Excel 端到端验收的已知缺口。

### 排除本地构建输出

新增原生冒烟项目的 `bin/` 和 `obj/` 忽略规则。源码和测试项目本身提交，发布 ZIP 仅通过发行脚本作为 GitHub 资产上传，而不进入仓库历史。

## Risks / Trade-offs

- [版本只在部分组件更新] → 用版本搜索、构建后的 `release.json`、`--diagnose` 和 ZIP 内文件检查交叉验证。
- [本地构建输出被误加入提交] → 在 `.gitignore` 中增加原生冒烟输出规则，并在暂存前使用 `git status` 和 `git diff --cached --check` 审阅。
- [Windows 或 Excel 主机差异导致实机功能无法完全自动验证] → 运行 Node、Launcher 和原生桥冒烟测试，发行说明明确保留真实 Excel 的外部验收项。
- [GitHub 发布失败或资产不完整] → 先推送发行提交和标签，再创建 Release；失败时保留已推送标签与本地 ZIP，以便重试上传而不改写历史。

## Migration Plan

1. 更新版本常量、脚本和文档，生成 `0.0.2` 资产。
2. 运行项目验证、OpenSpec 严格校验和发行诊断。
3. 提交并推送 `main`，创建和推送轻量标签 `v0.0.2`。
4. 使用 ZIP、SHA-256 和英文更新日志创建 GitHub Release，随后读取远端 Release、标签和资产确认发布。

回滚只通过后续补丁版本完成；不删除或重写已发布资产和标签。

## Open Questions

无。
