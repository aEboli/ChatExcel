## Why

ChatEx 页脚彩蛋目前以抽象 CSS 小人表现跑步场景，无法体现用户提供的人物图。将这六张图作为本地场景角色后，页脚会更贴合用户指定的视觉素材，同时保留原有低干扰、可访问的交互。

## What Changes

- 将页脚田野场景的六个 CSS 几何行走角色替换为六张用户提供的本地人物图。
- 保留现有页脚固定高度、悬停/键盘聚焦可见度、点击活动状态与 reduced-motion 行为。
- 在项目静态资源中保存经优化的角色资源，不请求外部图片或字体。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `taskpane-experience`: 页脚彩蛋允许使用打包的本地人物图来呈现田野跑步角色。

## Impact

- 修改 `src/taskpane/taskpane.html`、`src/taskpane/taskpane.css` 与任务窗格布局测试。
- 新增 `assets/easter-characters/` 下的六张本地角色图片。
- 不影响模型令牌边界、任务窗格 API、Excel 工作簿行为或外部网络依赖。
