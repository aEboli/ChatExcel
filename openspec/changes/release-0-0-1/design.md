## Release metadata

`src/shared/app-info.js` 是服务健康接口的版本事实来源；`package.json` 和 `package-lock.json` 的根包版本与它同步。`scripts/build-launcher.ps1` 写入同一 `0.0.1` 到 `release.json`，避免发行目录继续显示旧版本。

GitHub 发布使用轻量的 `v0.0.1` tag。源码归档由 GitHub 自动生成；Windows 发行资产为 `ChatExcel-Launcher-0.0.1-win-x64.zip` 和同目录的 SHA-256 校验文件。构建时排除 `node_modules` 之外的测试、OpenSpec 和本地运行数据，发行目录仍内置 Node.js 与侧载依赖。

## Footer detail

任务窗格在 composer 下方增加独立 `.easter-footer`，保持 28px 固定高度，避免压缩对话区域时发生布局跳动。按钮提供 `aria-label`、`aria-pressed` 和 title；DOM 中的 `easter-stage` 使用 `aria-hidden`，不会把装饰角色暴露给辅助技术。

动效由三个层次组成：一条基线、缓慢横向移动的卡片/圆球，以及沿基线行走的 CSS 几何角色。默认低透明度，悬停、键盘聚焦和点击激活时提高透明度并加快移动；全局 `prefers-reduced-motion: reduce` 规则将动画压缩为一次性静态状态。

## Documentation

README 首屏使用项目图标、版本徽章、用途摘要和截图；正文按“解决问题 -> 能力 -> 架构/技术栈 -> 安装 -> 一键发行 -> 配置 -> 场景 -> 安全 -> 验证”递进。动效说明链接到用户提供的 Detail 参考页，并明确 ChatExcel 使用仓库内 CSS 自绘实现。

## Safety

Git 操作只针对当前仓库的发行提交、`v0.0.1` 标签和 GitHub Release。发布前执行 JavaScript 检查、单元测试、清单校验、依赖审计、OpenSpec 严格校验、发行包诊断和 `git diff --check`；推送前确认工作树中没有未审阅的凭据或运行时文件。
