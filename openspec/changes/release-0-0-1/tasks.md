## 1. Product detail

- [x] 1.1 增加页脚彩蛋 DOM、CSS 几何动效、点击激活状态和 reduced-motion/键盘验收。
- [x] 1.2 更新中英文 README 的首屏层次、发行入口、技术栈和 Detail 参考说明。

## 2. Version and release artifacts

- [x] 2.1 将 npm、服务健康接口和 Launcher 元数据统一为 `0.0.1`。
- [x] 2.2 创建中英文 `CHANGELOG`，构建 Windows x64 ZIP 和 SHA-256 校验文件。
- [x] 2.3 创建 `v0.0.1` Git 标签和 GitHub Release，资产与更新日志一致。

## 3. Verification

- [x] 3.1 运行 `npm run check`、`npm test`、`npm run validate:manifest`、`npm audit --omit=dev` 和 `openspec validate --changes --strict --no-interactive`。
- [x] 3.2 重新构建 Launcher，运行 `npm run diagnose:launcher`，确认发行包中版本为 `0.0.1`。
- [x] 3.3 在 400x900 和 320x700 预览页检查页脚不造成横向溢出，点击/聚焦彩蛋可见，reduced-motion 下不持续运动。
- [x] 3.4 推送后读取 GitHub tag、Release 和资产信息，确认远程状态可复核。
