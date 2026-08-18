## Context

`package.json` 是发布版本的单一来源。构建脚本将其传给 `dotnet publish`，并据此写入 Launcher 元数据、`release.json` 和 ZIP 文件名。`v0.0.4` 已发布，不能覆盖标签或替换既有资产，因此本轮采用新的补丁版本 `0.0.5`。

当前工作树还包含大量不属于本次发布的未暂存 OpenSpec 删除。发布提交必须通过显式文件白名单创建；暂存区不得出现任何删除项。

## Decisions

### 以 `0.0.5` 作为全链路标识

根包、锁文件、Launcher 默认程序集版本、健康接口、`release.json`、ZIP、Git 标签和 GitHub Release 都使用 `0.0.5`。Office 清单的 `1.0.0.1` 是独立的 Office 清单版本，用于刷新其本地 URL，不与 npm 发行版本强行绑定。

### 从干净隔离工作树构建发行包

先推送包含显式白名单改动的 `main` 提交，再从该提交创建干净隔离工作树构建 ZIP、执行 `--diagnose` 和检查内容。这样工作区内的 `.runtime`、日志、未跟踪项和未暂存删除均不能进入发行资产。

### 发布前复核远端

推送后读取远端 `main`、注释标签、GitHub Release 与资产元数据，确认 ZIP 哈希与发布的 `.sha256` 文件一致。只有 Release 不是 draft/prerelease 且资产齐全时才完成本变更。
