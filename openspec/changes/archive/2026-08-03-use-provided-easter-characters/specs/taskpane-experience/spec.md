## MODIFIED Requirements

### Requirement: 提供低干扰页脚彩蛋

任务窗格 SHALL 在输入区下方提供一个固定高度的页脚彩蛋入口；装饰场景 MUST 使用打包的本地 CSS 和本地人物图，不得依赖外部脚本、网络图片或字体，并 MUST 尊重键盘和 reduced-motion 设置。

#### Scenario: 探索页脚

- **WHEN** 用户悬停或键盘聚焦 ChatEx 页脚入口
- **THEN** 基线、田野和六个本地人物图角色提高可见度，且不遮挡输入区、操作记录或对话内容

#### Scenario: 点击固定彩蛋

- **WHEN** 用户点击页脚入口
- **THEN** 彩蛋进入或退出活动状态，入口更新 `aria-pressed` 和可操作提示，主聊天流程不改变

#### Scenario: 用户偏好减少动效

- **WHEN** 浏览器启用 `prefers-reduced-motion: reduce`
- **THEN** 人物图角色不持续横向运动，入口和基线仍保持可见且可操作

#### Scenario: 离线显示人物图

- **WHEN** 任务窗格在无网络连接的本地加载项运行时打开
- **THEN** 六个角色均从打包的本地静态资源加载，不产生外部图片请求
