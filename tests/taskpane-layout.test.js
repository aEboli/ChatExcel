import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const [taskpaneHtml, taskpaneJs, taskpaneCss, manifest, historyPreview] = await Promise.all([
  readFile(new URL("../src/taskpane/taskpane.html", import.meta.url), "utf8"),
  readFile(new URL("../src/taskpane/taskpane.js", import.meta.url), "utf8"),
  readFile(new URL("../src/taskpane/taskpane.css", import.meta.url), "utf8"),
  readFile(new URL("../manifest.xml", import.meta.url), "utf8"),
  readFile(new URL("../src/taskpane/history-preview.js", import.meta.url), "utf8"),
]);

test("任务窗格不再提供图片附件入口，并优先单行展示控制条", () => {
  assert.doesNotMatch(taskpaneHtml, /id="(?:image-input|image-button|attachment-list)"/);
  assert.doesNotMatch(taskpaneJs, /prepareImageFile|addSelectedImages|clipboardData\?\.files/);
  assert.match(taskpaneCss, /\.composer-toolbar\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/);
  assert.match(taskpaneCss, /\.model-anchor\s*\{[\s\S]*max-width:\s*none;/);
  const emptyStateRule = taskpaneCss.match(/\.empty-state\s*\{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(emptyStateRule, /height:\s*100%/);
});

test("页脚彩蛋在固定高度内展示田野跑步场景", async () => {
  assert.match(taskpaneHtml, /class="easter-sun"/);
  assert.match(taskpaneHtml, /class="easter-hills"/);
  assert.match(taskpaneHtml, /class="easter-field"/);
  assert.match(taskpaneHtml, /class="easter-poles"/);
  assert.equal((taskpaneHtml.match(/class="easter-walker walker-/g) ?? []).length, 6);
  assert.doesNotMatch(taskpaneHtml, /class="easter-brand"/);
  assert.match(taskpaneHtml, /aria-label="打开 ChatEx 页脚彩蛋"/);
  const characterPaths = [...taskpaneHtml.matchAll(/src="(\/assets\/easter-characters\/[^"]+\.webp)"/g)].map((match) => match[1]);
  assert.deepEqual(characterPaths, [
    "/assets/easter-characters/runner-coral.webp",
    "/assets/easter-characters/runner-white-dress.webp",
    "/assets/easter-characters/runner-white-shirt.webp",
    "/assets/easter-characters/runner-coral-wide.webp",
    "/assets/easter-characters/runner-pony-close.webp",
    "/assets/easter-characters/runner-sunset-wide.webp",
  ]);
  await Promise.all(characterPaths.map((path) => access(new URL(`..${path}`, import.meta.url))));
  assert.match(taskpaneCss, /\.easter-footer\s*\{[\s\S]*flex:\s*0\s+0\s+28px;[\s\S]*height:\s*28px;[\s\S]*min-height:\s*28px;[\s\S]*max-height:\s*28px;/);
  assert.match(taskpaneCss, /\.easter-walker\s*\{[\s\S]*animation:\s*easter-walk\s+12s\s+linear\s+infinite;/);
  assert.match(taskpaneCss, /\.easter-walker\s*\{[\s\S]*width:\s*24px;[\s\S]*height:\s*24px;/);
  assert.match(taskpaneCss, /\.easter-walker img\s*\{[\s\S]*object-fit:\s*contain;/);
  assert.match(taskpaneCss, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.easter-walker\s*\{[\s\S]*animation:\s*none\s*!important;/);
});

test("底部思考、上下文和审批控件使用可读的状态图标", () => {
  assert.match(taskpaneHtml, /class="effort-glyph"[\s\S]*class="effort-meter"/);
  assert.match(taskpaneHtml, /class="context-badge"[\s\S]*id="context-label"/);
  assert.match(taskpaneHtml, /id="mode-icon"[^>]+approval\.svg/);
  assert.match(taskpaneCss, /\.context-badge\s*\{[\s\S]*border-radius:\s*50%;/);
  assert.match(taskpaneCss, /\.effort-button\[data-effort-level="4"\]/);
  assert.match(taskpaneJs, /function reasoningEffortLevel\(effort\)/);
  assert.match(taskpaneJs, /contextButton\.style\.setProperty\("--context-progress"/);
  assert.match(taskpaneJs, /elements\.modeButton\.setAttribute\("aria-label", elements\.modeButton\.title\)/);
});

test("模型和推理强度控件按 Codex 式设置行显示当前值", () => {
  assert.match(taskpaneHtml, /class="toolbar-button settings-row-button model-button"/);
  assert.match(taskpaneHtml, /class="control-label">模型<\/span>/);
  assert.match(taskpaneHtml, /class="control-value" id="model-label"/);
  assert.match(taskpaneHtml, /class="control-label">推理强度<\/span>/);
  assert.match(taskpaneHtml, /class="control-value" id="effort-label"/);
  assert.match(taskpaneCss, /\.settings-row-button\s*\{[\s\S]*justify-content:\s*flex-start;/);
  assert.match(taskpaneCss, /\.settings-row-button \.chevron-forward\s*\{[\s\S]*transform:\s*rotate\(-90deg\)/);
  assert.match(taskpaneJs, /function modelDisplayName\(modelId\)/);
  assert.match(taskpaneJs, /function reasoningEffortDisplayName\(effort\)/);
  assert.match(taskpaneJs, /推理强度：\$\{effortName\}/);
});

test("模型摘要打开统一设置面板并支持二级选择与重置", () => {
  assert.match(taskpaneHtml, /id="model-settings-menu"[^>]+role="menu"/);
  assert.match(taskpaneHtml, /id="model-settings-model-row"[^>]+role="menuitem"/);
  assert.match(taskpaneHtml, /id="effort-button"[^>]+role="menuitem"/);
  assert.match(taskpaneHtml, /id="reset-model-settings"/);
  assert.match(taskpaneHtml, /id="model-menu-back"/);
  assert.match(taskpaneHtml, /id="effort-menu-back"/);
  assert.match(taskpaneJs, /function openModelSettingsSubmenu\(kind\)/);
  assert.match(taskpaneJs, /function resetModelSettings\(\)/);
  assert.match(taskpaneJs, /defaultReasoningEffortForModel\(defaultModel\)/);
  assert.match(taskpaneJs, /elements\.effortButton\.disabled = uiBusy \|\| availableReasoningEfforts\(\)\.length === 0;/);
  assert.match(taskpaneCss, /\.model-settings-menu\s*\{[\s\S]*width:\s*min\(236px,\s*calc\(100vw - 16px\)\);/);
  assert.match(taskpaneCss, /\.model-settings-reset\s*\{[\s\S]*justify-content:\s*space-between;/);
});

test("模型摘要移除机器人图标并完整显示当前值", () => {
  const modelButton = taskpaneHtml.match(/<button[^>]+id="model-button"[\s\S]*?<\/button>/)?.[0];

  assert.ok(modelButton, "应能定位模型摘要按钮");
  assert.doesNotMatch(modelButton, /model\.svg/);
  assert.match(taskpaneCss, /\.model-settings-summary\s*\{[\s\S]*font-size:\s*9px;/);
  assert.match(taskpaneCss, /\.model-settings-summary #model-label\s*\{[\s\S]*overflow:\s*visible;[\s\S]*text-overflow:\s*clip;[\s\S]*white-space:\s*nowrap;/);
  assert.match(taskpaneCss, /\.model-settings-effort-value\s*\{[\s\S]*max-width:\s*none;[\s\S]*overflow:\s*visible;[\s\S]*text-overflow:\s*clip;[\s\S]*white-space:\s*nowrap;/);
});

test("协议选择在右侧按模型示例提示", () => {
  assert.match(taskpaneHtml, /class="protocol-field"/);
  assert.match(taskpaneHtml, /id="protocol-model-list"/);
  assert.match(taskpaneJs, /"openai-responses": \["GPT-5", "GPT-4\.1", "o3", "o4-mini"\]/);
  assert.match(taskpaneJs, /"openai-chat-completions": \["Qwen3", "DeepSeek-V3", "GLM-4", "Kimi K2"\]/);
  assert.match(taskpaneJs, /"anthropic-messages": \["Claude Opus", "Claude Sonnet", "Claude Haiku"\]/);
  assert.match(taskpaneJs, /"google-gemini": \["Gemini 2\.5 Pro", "Gemini 2\.5 Flash", "Gemini Flash-Lite"\]/);
  assert.match(taskpaneJs, /renderSettingsProtocols[\s\S]*renderProtocolModelExamples\(\)/);
  assert.match(taskpaneJs, /elements\.apiProtocol\.addEventListener\("change", renderProtocolModelExamples\)/);
  assert.match(taskpaneCss, /\.protocol-field\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1\.18fr\);/);
  assert.match(taskpaneCss, /@media \(max-width: 439px\) \{[\s\S]*\.protocol-field\s*\{[\s\S]*grid-template-columns:\s*1fr;/);
});

test("模型配置按能力目录回填上下文，思考等级保持自动只读", () => {
  assert.match(taskpaneHtml, /for="settings-effort">思考等级（自动）</);
  assert.match(taskpaneHtml, /id="settings-effort" name="reasoningEffort" disabled/);
  assert.match(taskpaneJs, /function applySettingsModelContextWindow\(\)/);
  assert.match(taskpaneJs, /elements\.contextWindow\.value = String\(entry\.contextWindow\)/);
  assert.match(taskpaneJs, /自动（提供方默认）/);
  assert.match(taskpaneJs, /elements\.settingsEffort\.disabled = true;/);
  assert.match(taskpaneJs, /elements\.settingsModel\.addEventListener\("change", \(\) => \{[\s\S]*applySettingsModelContextWindow\(\);/);
  assert.doesNotMatch(taskpaneJs, /reasoningEffort:\s*elements\.settingsEffort\.value/);
});

test("流式任务在动作完成后重新定位最终助手消息", () => {
  assert.match(taskpaneJs, /history\.finalizeMessage\(messageId, text(?:, \{ preservePrefixLength \})?\)/);
});

test("多步骤流式终态保留较早模型步骤的文字", () => {
  assert.match(taskpaneJs, /let streamingAssistantStepTextLength = 0;/);
  assert.match(taskpaneJs, /case "tool_pending":\s*streamingAssistantStepTextLength = 0;/);
  assert.match(taskpaneJs, /case "model_step_boundary":\s*streamingAssistantStepTextLength = 0;/);
  assert.match(taskpaneJs, /history\.finalizeMessage\(messageId, text, \{ preservePrefixLength \}\)/);
});

test("流式重连会撤销当前尝试的文字后缀并显示重连进度", () => {
  assert.match(taskpaneJs, /case "stream_reset":\s*resetStreamingAssistant\(event\.discardTextLength\)/);
  assert.match(taskpaneJs, /case "provider_reconnecting":\s*\{/);
  assert.match(taskpaneJs, /网络连接已中断/);
  assert.match(taskpaneJs, /case "assistant_delta":\s*elements\.runStatus\.textContent = ""/);
  assert.match(taskpaneJs, /case "run_error":[\s\S]*?elements\.runStatus\.textContent = ""/);
  assert.match(taskpaneJs, /case "run_stopped":[\s\S]*?elements\.runStatus\.textContent = ""/);
});

test("窄任务窗格底部控制保持单行且动作按钮紧凑", () => {
  assert.doesNotMatch(taskpaneCss, /\.composer-toolbar\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);\s*\}/);
  assert.match(taskpaneCss, /\.mode-button\s*\{\s*width:\s*28px;\s*height:\s*28px;/);
  assert.match(taskpaneCss, /\.send-button\s*\{\s*width:\s*34px;\s*height:\s*28px;/);
  assert.match(taskpaneCss, /@media \(max-width: 439px\)[\s\S]*?\.action-controls\s*\{[\s\S]*?gap:\s*3px;[\s\S]*?justify-content:\s*flex-end;/);
  assert.doesNotMatch(manifest, /RequestedWidth|<Width>/);
});

test("任务窗格恢复并单独持久化审批偏好", () => {
  assert.match(taskpaneJs, /saveApprovalMode: \(approvalMode\) => requestJson\("\/api\/settings\/approval-mode"/);
  assert.match(taskpaneJs, /setApprovalMode\(configState\.settings\.approvalMode\)/);
  assert.match(taskpaneJs, /async function persistApprovalMode\(mode\)/);
  assert.match(taskpaneJs, /setApprovalMode\(previousMode\)/);
  assert.match(taskpaneJs, /approvalModeSaving/);
  assert.match(taskpaneJs, /message === "" \|\| runner\.running \|\| approvalModeSaving \|\| !configState/);
});

test("审批请求保持自动告知直执和需审批手动决定", () => {
  const requestApprovalSource = taskpaneJs.match(
    /function requestApproval\(call, \{ signal \}\) \{[\s\S]*?\n\}\n\nasync function safeExecuteTool/,
  )?.[0];

  assert.ok(requestApprovalSource, "应能定位 requestApproval 函数");
  assert.match(
    requestApprovalSource,
    /if \(approvalMode === "auto"\) \{[\s\S]*?appendMessage\("notice", `无需审批：即将执行/,
  );
  assert.match(requestApprovalSource, /if \(approvalMode === "auto"\) \{[\s\S]*?return Promise\.resolve\(true\);/);
  assert.match(requestApprovalSource, /elements\.approval\.hidden = false;/);
  assert.match(requestApprovalSource, /elements\.runStatus\.textContent = "等待审批";/);
  assert.match(requestApprovalSource, /const approve = \(\) => \{[\s\S]*?resolve\(true\);/);
  assert.match(requestApprovalSource, /const deny = \(\) => \{[\s\S]*?resolve\(false\);/);
  assert.match(requestApprovalSource, /elements\.approveButton\.addEventListener\("click", approve, \{ once: true \}\);/);
  assert.match(requestApprovalSource, /elements\.denyButton\.addEventListener\("click", deny, \{ once: true \}\);/);
});

test("任务窗格启动时探测提供方连通性，并同步模型和设置状态", () => {
  assert.match(taskpaneJs, /probeProviderConnectivity: \(\) => requestJson\("\/api\/provider-connectivity", \{ method: "POST", body: \{\} \}\)/);
  assert.match(taskpaneJs, /let providerProbeId = 0;/);
  assert.match(taskpaneJs, /async function refreshProviderConnectivity\(\)/);
  assert.match(taskpaneJs, /for \(const button of \[elements\.modelButton, elements\.settingsButton\]\) \{[\s\S]*?button\.dataset\.providerConnectivity = state;/);
  assert.match(taskpaneJs, /async function saveSettings\(event\) \{[\s\S]*?void refreshProviderConnectivity\(\);/);
  assert.match(taskpaneJs, /async function initializePreview\(\) \{[\s\S]*?await refreshProviderConnectivity\(\);/);
  assert.match(taskpaneJs, /async function initializeExcel\(info\) \{[\s\S]*?configResult\.status === "fulfilled"\) await refreshProviderConnectivity\(\);/);
  assert.match(taskpaneJs, /async function initializeLegacy\(\) \{[\s\S]*?await refreshProviderConnectivity\(\);/);
  assert.match(taskpaneCss, /#model-button\[data-provider-connectivity="ready"\],[\s\S]*?#settings-button\[data-provider-connectivity="ready"\]/);
  assert.match(taskpaneCss, /#model-button\[data-provider-connectivity="error"\],[\s\S]*?#settings-button\[data-provider-connectivity="error"\]/);
  assert.match(taskpaneCss, /#model-button\[data-provider-connectivity="ready"\] > img,[\s\S]*?#settings-button\[data-provider-connectivity="ready"\] > img\s*\{[\s\S]*?filter:/);
  assert.match(taskpaneCss, /#model-button\[data-provider-connectivity="error"\] > img,[\s\S]*?#settings-button\[data-provider-connectivity="error"\] > img\s*\{[\s\S]*?filter:/);
});

test("对话按角色使用三分之二宽气泡，并把连续动作收束为带箭头的居中流程", () => {
  assert.match(taskpaneCss, /\.message\s*\{[\s\S]*max-inline-size:\s*66\.667%;/);
  assert.match(taskpaneCss, /\.message\s*\{[\s\S]*border-radius:\s*18px;/);
  assert.match(taskpaneCss, /\.message\.user\s*\{[\s\S]*margin-left:\s*auto;/);
  assert.match(taskpaneCss, /\.message\.assistant\s*\{[\s\S]*margin-right:\s*auto;/);
  assert.match(taskpaneCss, /\.action-flow\s*\{[\s\S]*justify-items:\s*center;/);
  assert.match(taskpaneCss, /\.action-flow-step\.message\.notice\s*\{[\s\S]*border-radius:\s*999px;/);
  assert.match(taskpaneCss, /\.action-flow-arrow\s*\{[\s\S]*rotate\(180deg\)/);
  assert.match(taskpaneJs, /function createActionFlow\(entries\)/);
  assert.match(taskpaneJs, /createIcon\("\/assets\/fluent\/arrow-up\.svg"\)/);
  assert.match(taskpaneJs, /visibleMessages\[index \+ 1\]\?\.role === "notice"/);
});

test("操作记录提供内存中的表格预览，不改变或保存工作簿", () => {
  assert.match(taskpaneHtml, /id="history-preview"/);
  assert.match(taskpaneHtml, /id="history-preview-body"/);
  assert.match(taskpaneJs, /let selectedHistoryActivityIndex = null;/);
  assert.match(taskpaneJs, /selectedHistoryActivityIndex = entry\.index;/);
  assert.match(taskpaneJs, /elements\.historyPreview\.hidden = !entry;/);
  assert.match(taskpaneJs, /仅预览，不会修改或保存工作簿/);
  assert.match(taskpaneJs, /captureToolPreview,/);
  assert.match(taskpaneCss, /\.history-preview\s*\{/);
  assert.match(taskpaneCss, /\.history-preview-body\s*\{[\s\S]*?overflow: auto;/);
  assert.match(historyPreview, /getImage\(\)/);
  assert.doesNotMatch(historyPreview, /fetch\(|localStorage|sessionStorage|\.values\s*=/);
});
