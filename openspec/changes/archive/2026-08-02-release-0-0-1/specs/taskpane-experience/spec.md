## ADDED Requirements

### Requirement: 提供低干扰页脚彩蛋

任务窗格 SHALL 在输入区下方提供一个固定高度的页脚彩蛋入口；装饰动画 MUST 使用本地 CSS，不得依赖外部脚本、图片或字体，并 MUST 尊重键盘和 reduced-motion 设置。

#### Scenario: 探索页脚

- **WHEN** 用户悬停或键盘聚焦 ChatEx 页脚入口
- **THEN** 基线上的 CSS 几何物件和行走角色提高可见度，且不遮挡输入区、操作记录或对话内容

#### Scenario: 点击固定彩蛋

- **WHEN** 用户点击页脚入口
- **THEN** 彩蛋进入或退出活动状态，入口更新 `aria-pressed` 和可操作提示，主聊天流程不改变

#### Scenario: 用户偏好减少动效

- **WHEN** 浏览器启用 `prefers-reduced-motion: reduce`
- **THEN** 彩蛋不持续横向运动，入口和基线仍保持可见且可操作
