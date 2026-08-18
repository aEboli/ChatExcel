## 1. 本机配置读取

- [x] 1.1 让 Codex provider 支持 `auth.json.OPENAI_API_KEY` 和新版 `ultra` 思考等级
- [x] 1.2 新增 Claude CLI `settings.json` 解析与自动/显式来源加载
- [x] 1.3 添加 CLI 配置解析、回退和令牌脱敏测试

## 2. 运行时与持久化

- [x] 2.1 在 RuntimeConfigStore 中持久化并校验 `systemSource`
- [x] 2.2 让模型发现和配置更新使用所选系统来源，并在切换失败时回滚
- [x] 2.3 保持旧设置文件向后兼容并补充运行时测试

## 3. 设置页

- [x] 3.1 添加系统 CLI 来源选择控件和自定义表单故障回退
- [x] 3.2 提交来源选择并补充任务窗格结构回归测试

## 4. 验证

- [ ] 4.1 运行 `npm run check`、定向配置测试和 `npm test`
- [ ] 4.2 重启本地服务并人工检查 `/api/config` 与设置页来源切换
