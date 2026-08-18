import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const [taskpaneHtml, taskpaneJs, taskpaneCss, manifest, historyPreview, modelSelection] = await Promise.all([
  readFile(new URL("../src/taskpane/taskpane.html", import.meta.url), "utf8"),
  readFile(new URL("../src/taskpane/taskpane.js", import.meta.url), "utf8"),
  readFile(new URL("../src/taskpane/taskpane.css", import.meta.url), "utf8"),
  readFile(new URL("../manifest.xml", import.meta.url), "utf8"),
  readFile(new URL("../src/taskpane/history-preview.js", import.meta.url), "utf8"),
  readFile(new URL("../src/taskpane/model-selection.js", import.meta.url), "utf8"),
]);

test("任务窗格提供剪贴板和拖入图片附件、放大预览及窄窗格布局", () => {
  assert.match(taskpaneHtml, /id="attachment-error"[^>]+role="alert"/);
  assert.match(taskpaneHtml, /id="attachment-list"[^>]+aria-label="待发送图片"/);
  assert.match(taskpaneHtml, /id="image-drop-hint"[^>]+role="status"/);
  assert.match(taskpaneHtml, /id="image-preview-modal"/);
  assert.match(taskpaneHtml, /id="image-preview-close"[^>]+aria-label="关闭图片预览"/);
  assert.match(taskpaneJs, /clipboardImageFiles\(clipboardData\)/);
  assert.match(taskpaneJs, /transferHasFiles,\s*\n\}\s*from "\.\/image-attachments\.js"/);
  assert.match(taskpaneJs, /promptInput\.addEventListener\("paste"/);
  assert.match(taskpaneJs, /appShell\.addEventListener\("dragenter", handleImageDragEnter\)/);
  assert.match(taskpaneJs, /appShell\.addEventListener\("dragover", handleImageDragOver\)/);
  assert.match(taskpaneJs, /appShell\.addEventListener\("dragleave", handleImageDragLeave\)/);
  assert.match(taskpaneJs, /appShell\.addEventListener\("drop", handleImageDrop\)/);
  assert.match(taskpaneJs, /function handleImageDrop\(event\)[\s\S]*?clipboardImageFiles\(transferData\)[\s\S]*?addSelectedImages\(files/);
  assert.match(taskpaneJs, /function imageDropAvailable\(\)[\s\S]*?!uiBusy[\s\S]*?settingsView\.hidden[\s\S]*?confirmModal\.hidden[\s\S]*?imagePreviewModal\.hidden/);
  assert.match(taskpaneJs, /function clearImageDropTarget\(\)[\s\S]*?imageDropDepth = 0/);
  assert.match(taskpaneJs, /function setBusy\(busy\) \{[\s\S]*?clearImageDropTarget\(\)/);
  assert.match(taskpaneJs, /globalThis\.addEventListener\?\.\("blur", clearImageDropTarget\)/);
  assert.match(taskpaneJs, /clipboardData\?\.getData\?\.\("text\/plain"\)/);
  assert.match(taskpaneJs, /message === "" && attachments\.length === 0/);
  assert.match(taskpaneJs, /elements\.imagePreviewClose\.addEventListener\("click", closeImagePreview\)/);
  assert.match(taskpaneJs, /if \(!elements\.imagePreviewModal\.hidden\) \{[\s\S]*?closeImagePreview\(\)/);
  assert.match(taskpaneCss, /\.attachment-list\s*\{[\s\S]*?overflow-x:\s*auto;/);
  assert.match(taskpaneCss, /\.composer\.is-image-drop-target\s*\{[\s\S]*?border-color:/);
  assert.match(taskpaneCss, /\.image-drop-hint\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?min-width:\s*0;[\s\S]*?overflow-wrap:\s*anywhere;/);
  assert.match(taskpaneCss, /\.attachment-item\s*\{[\s\S]*?flex:\s*0\s+0\s+66px;/);
  assert.match(taskpaneCss, /\.image-preview-backdrop\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(taskpaneCss, /\.composer-toolbar\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/);
  assert.match(taskpaneCss, /\.model-anchor\s*\{[\s\S]*max-width:\s*none;/);
  const emptyStateRule = taskpaneCss.match(/\.empty-state\s*\{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(emptyStateRule, /height:\s*100%/);
});

test("页脚多人赛跑在固定高度内展示六名本地人物", async () => {
  assert.match(taskpaneHtml, /class="easter-sun"/);
  assert.match(taskpaneHtml, /class="easter-hills"/);
  assert.match(taskpaneHtml, /class="easter-field"/);
  assert.match(taskpaneHtml, /class="easter-poles"/);
  const runners = [
    "runner-coral.webp",
    "runner-white-dress.webp",
    "runner-white-shirt.webp",
    "runner-coral-wide.webp",
    "runner-pony-close.webp",
    "runner-sunset-wide.webp",
  ];
  assert.equal((taskpaneHtml.match(/class="easter-walker /g) ?? []).length, runners.length);
  for (const runner of runners) assert.match(taskpaneHtml, new RegExp(`easter-characters/${runner.replace(".", "\\.")}`));
  assert.match(taskpaneHtml, /id="easter-count"/);
  assert.match(taskpaneHtml, /id="easter-stage"/);
  assert.match(taskpaneHtml, /id="easter-status"[^>]+aria-live="polite"/);
  assert.doesNotMatch(taskpaneHtml, /class="easter-brand"/);
  assert.match(taskpaneHtml, /aria-label="开始页脚多人赛跑"/);
  await Promise.all(runners.map((runner) => access(new URL(`../assets/easter-characters/${runner}`, import.meta.url))));
  assert.match(taskpaneCss, /\.easter-footer\s*\{[\s\S]*flex:\s*0\s+0\s+24px;[\s\S]*height:\s*24px;[\s\S]*min-height:\s*24px;[\s\S]*max-height:\s*24px;/);
  assert.match(taskpaneCss, /\.easter-trigger\s*\{[\s\S]*height:\s*24px;/);
  assert.match(taskpaneCss, /\.easter-walker\s*\{[\s\S]*transform:\s*translate3d\(var\(--runner-translate,\s*-26px\),\s*0,\s*0\);[\s\S]*will-change:\s*transform;/);
  assert.match(taskpaneCss, /\.easter-footer\.is-playing \.easter-walker img\s*\{[\s\S]*animation:\s*easter-runner-stride/);
  assert.match(taskpaneCss, /\.easter-count\s*\{[\s\S]*left:\s*50%;/);
  assert.match(taskpaneJs, /runnerTranslatePixels/);
  assert.match(taskpaneJs, /easterStage/);
  assert.match(taskpaneJs, /clientWidth/);
  assert.match(taskpaneJs, /walker\.offsetWidth/);
  assert.match(taskpaneJs, /ResizeObserver/);
  assert.match(taskpaneJs, /reducedMotionQuery\?\.addEventListener\?\.\("change", handleReducedMotionChange\)/);
  assert.match(taskpaneJs, /reducedMotionQuery\?\.removeEventListener\?\.\("change", handleReducedMotionChange\)/);
  assert.match(taskpaneJs, /easterWalkers/);
  assert.match(taskpaneJs, /--runner-translate/);
  assert.match(taskpaneJs, /REDUCED_MOTION_RUNNER_PROGRESS/);
  assert.match(taskpaneJs, /footerAnimation\.toggleManual\(\)/);
  assert.match(taskpaneJs, /footerAnimation\.lockForConversation\(\)/);
  assert.match(taskpaneJs, /footerAnimation\.unlockConversation\(\)/);
  assert.match(taskpaneJs, /easterTrigger\.disabled = state\.locked/);
  assert.doesNotMatch(taskpaneCss, /--runner-reduced-translate/);
  assert.match(taskpaneCss, /\.easter-walker img\s*\{[\s\S]*animation:\s*none\s*!important;/);
  assert.doesNotMatch(taskpaneHtml, /duck-/);
  assert.doesNotMatch(taskpaneCss, /easter-duck/);
  assert.doesNotMatch(taskpaneJs, /duck-/);
});

test("底部思考、上下文和审批控件使用可读的状态图标", () => {
  assert.match(taskpaneHtml, /class="effort-glyph"[\s\S]*class="effort-meter"/);
  assert.match(taskpaneHtml, /class="context-badge"[\s\S]*id="context-label"/);
  assert.match(taskpaneHtml, /id="mode-icon"[^>]+approval\.svg/);
  assert.match(taskpaneCss, /\.context-badge\s*\{[\s\S]*border-radius:\s*50%;/);
  assert.match(taskpaneCss, /\.effort-button\[data-effort-level="4"\]/);
  assert.match(taskpaneJs, /reasoningEffortLevel,[\s\S]{0,200}from "\.\/model-selection\.js"/);
  assert.match(modelSelection, /export function reasoningEffortLevel\(effort\)/);
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
  assert.match(taskpaneJs, /reasoningEffortDisplayName,[\s\S]{0,200}from "\.\/model-selection\.js"/);
  assert.match(modelSelection, /value === "minimal"[\s\S]*return "最低"/);
  assert.match(modelSelection, /value === "xhigh"[\s\S]*return "极高"/);
  assert.match(modelSelection, /value === "max"[\s\S]*return "最高"/);
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
  assert.match(taskpaneCss, /\.model-settings-anchor\s*\{[\s\S]*flex:\s*1 1 auto;/);
  assert.match(taskpaneCss, /\.model-button,[\s\S]*?\.effort-button\s*\{[\s\S]*width:\s*100%;/);
  assert.match(taskpaneCss, /\.model-settings-summary\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*max-content\)\s+3px\s+auto;/);
  assert.match(taskpaneCss, /\.model-settings-summary\s*\{[\s\S]*justify-content:\s*start;/);
  assert.doesNotMatch(taskpaneCss, /\.model-settings-summary\s*\{[\s\S]*?padding-right:\s*2em;/);
  assert.match(taskpaneCss, /\.model-settings-summary #model-label\s*\{[\s\S]*justify-self:\s*start;/);
  assert.match(taskpaneCss, /\.model-settings-effort-value\s*\{[\s\S]*justify-self:\s*start;/);
  assert.match(taskpaneCss, /\.model-button > \.chevron\s*\{[\s\S]*visibility:\s*hidden;/);
  assert.match(taskpaneCss, /\.model-settings-summary #model-label\s*\{[\s\S]*overflow:\s*visible;[\s\S]*text-overflow:\s*clip;[\s\S]*white-space:\s*nowrap;/);
  assert.match(taskpaneCss, /\.model-settings-effort-value\s*\{[\s\S]*max-width:\s*none;[\s\S]*overflow:\s*visible;[\s\S]*text-overflow:\s*clip;[\s\S]*white-space:\s*nowrap;/);
});

test("主界面完整显示工作簿名并展示 ChatExcel 能力欢迎语", () => {
  const workbookLabelRule = taskpaneCss.match(/\.workbook-label\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(taskpaneHtml, /<strong>你好，我是 ChatExcel，当前工作簿旁的 AI Agent<\/strong>/);
  assert.match(taskpaneHtml, /读取和分析工作簿与选区；写入值和公式/);
  assert.match(taskpaneHtml, /模型与推理可选；支持粘贴 PNG\/JPEG\/WebP 图片/);
  assert.doesNotMatch(taskpaneHtml, /准备就绪/);
  assert.match(taskpaneJs, /heading\.textContent = "你好，我是 ChatExcel，当前工作簿旁的 AI Agent";/);
  assert.match(taskpaneJs, /读取和分析工作簿与选区；写入值和公式/);
  assert.match(taskpaneJs, /模型与推理可选；支持粘贴 PNG\/JPEG\/WebP 图片/);
  assert.doesNotMatch(taskpaneJs, /准备就绪/);
  assert.match(workbookLabelRule, /overflow-wrap:\s*anywhere;/);
  assert.match(workbookLabelRule, /white-space:\s*normal;/);
  assert.doesNotMatch(workbookLabelRule, /text-overflow:\s*ellipsis;/);
  assert.match(taskpaneCss, /\.empty-state-copy\s*\{[\s\S]*min-width:\s*0;/);
  assert.match(taskpaneCss, /\.empty-state-copy p\s*\{[\s\S]*overflow-wrap:\s*anywhere;/);
});

test("审批与发送控件缩小可见图标但保留桌面命中区", () => {
  assert.match(taskpaneCss, /\.mode-button\s*\{[\s\S]*width:\s*24px;[\s\S]*height:\s*24px;/);
  assert.match(taskpaneCss, /\.mode-button > img\s*\{[\s\S]*width:\s*12px;[\s\S]*height:\s*12px;/);
  assert.match(taskpaneCss, /\.send-button\s*\{[\s\S]*width:\s*28px;[\s\S]*height:\s*24px;/);
  assert.match(taskpaneCss, /\.send-button \.send-icon\s*\{[\s\S]*width:\s*14px;[\s\S]*height:\s*14px;/);
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

test("任务窗格将官方最大输出与上下文窗口分开呈现", () => {
  assert.match(taskpaneJs, /selectedModelEntry\.maxOutputLabel/);
  assert.match(taskpaneJs, /单次最大输出 \$\{maxOutputLabel\.trim\(\)\}/);
  assert.match(taskpaneJs, /maxOutputSource: config\.maxOutputSource \?\? null/);
  assert.match(taskpaneJs, /单次最大输出 " \+ entry\.maxOutputLabel\.trim\(\) \+ "（官方模型目录）。/);
  assert.match(taskpaneJs, /usedTokens\.toLocaleString\(\).*limitTokens\.toLocaleString\(\)/);
});

test("任务窗格区分已证实能力、兼容档位和自动状态", () => {
  assert.match(taskpaneJs, /compatibleReasoningEfforts/);
  assert.match(taskpaneJs, /reasoningEffortMenuValues\(modelEntry\(selectedModel\)\)/);
  assert.match(taskpaneJs, /description = effort === null[\s\S]*"兼容档位"/);
  assert.match(taskpaneJs, /replaceConversationModels\(result\.models\)/);
  assert.match(taskpaneJs, /settingsDiscoveredModels = result\.models\.map\(\(model\) => normalizeReasoningModel\(normalizeModelOutputCapability\(model\)\)\)/);
  assert.match(taskpaneJs, /模型接口未声明思考等级，默认使用提供方自动模式。/);
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
  assert.match(taskpaneCss, /\.mode-button\s*\{\s*width:\s*24px;\s*height:\s*24px;/);
  assert.match(taskpaneCss, /\.send-button\s*\{\s*width:\s*28px;\s*height:\s*24px;/);
  assert.match(taskpaneCss, /@media \(max-width: 439px\)[\s\S]*?\.action-controls\s*\{[\s\S]*?gap:\s*3px;[\s\S]*?justify-content:\s*flex-end;/);
  assert.doesNotMatch(manifest, /RequestedWidth|<Width>/);
});

test("任务窗格使用紧凑密度并保留正文与桌面控件可读下限", () => {
  const appShellRule = taskpaneCss.match(/\.app-shell\s*\{[^}]*\}/)?.[0] ?? "";

  assert.match(appShellRule, /gap:\s*5px;/);
  assert.match(appShellRule, /padding:\s*5px;/);
  assert.doesNotMatch(appShellRule, /(?:transform|zoom)\s*:/);
  assert.match(taskpaneCss, /\.topbar\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?padding:\s*5px\s+7px;/);
  assert.match(taskpaneCss, /\.section-heading\s*\{[\s\S]*?min-height:\s*30px;/);
  assert.match(taskpaneCss, /\.activity-group-header\s*\{[\s\S]*?min-height:\s*38px;/);
  assert.match(taskpaneCss, /\.activity-row\s*\{[\s\S]*?min-height:\s*32px;/);
  assert.match(taskpaneCss, /\.message\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*17px;/);
  assert.match(taskpaneCss, /\.composer-shell\s*\{[\s\S]*?padding:\s*5px;/);
  assert.match(taskpaneCss, /\.composer textarea\s*\{[\s\S]*?height:\s*32px;[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*17px;/);
  assert.match(taskpaneCss, /\.toolbar-button,[\s\S]*?\.mode-button\s*\{[\s\S]*?height:\s*28px;/);
  assert.match(taskpaneCss, /\.icon-button\s*\{[\s\S]*?height:\s*30px;/);
  assert.match(taskpaneCss, /\.text-button,[\s\S]*?\.inline-button\s*\{[\s\S]*?min-height:\s*24px;/);
  assert.match(taskpaneCss, /\.switch\s*\{[\s\S]*?height:\s*24px;/);
  assert.match(taskpaneCss, /\.settings-header\s*\{[\s\S]*?min-height:\s*44px;/);
});

test("任务窗格恢复并单独持久化审批偏好", () => {
  assert.match(taskpaneJs, /saveApprovalMode: \(approvalMode\) => requestJson\("\/api\/settings\/approval-mode"/);
  assert.match(taskpaneJs, /setApprovalMode\(configState\.settings\.approvalMode\)/);
  assert.match(taskpaneJs, /async function persistApprovalMode\(mode\)/);
  assert.match(taskpaneJs, /setApprovalMode\(previousMode\)/);
  assert.match(taskpaneJs, /approvalModeSaving/);
  assert.match(taskpaneJs, /message === "" && attachments\.length === 0\) \|\| runner\.running \|\| approvalModeSaving \|\| !configState/);
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

test("配置读取失败时红色设置入口仍可打开并提供修复表单", () => {
  const openSettingsSource = taskpaneJs.match(
    /function openSettings\(\) \{[\s\S]*?\n\}/,
  )?.[0] ?? "";
  const populateSettingsSource = taskpaneJs.match(
    /function populateSettings\(\) \{[\s\S]*?\n\}/,
  )?.[0] ?? "";

  assert.match(openSettingsSource, /if \(runner\.running\) return;/);
  assert.doesNotMatch(openSettingsSource, /!configState/);
  assert.match(openSettingsSource, /populateSettings\(\);[\s\S]*?settingsView\.hidden = false;/);
  assert.match(
    populateSettingsSource,
    /if \(!configState\) \{[\s\S]*?renderSettingsProtocols\(\);[\s\S]*?renderSettingsModels\(\);[\s\S]*?toggleCustomSettings\(\);[\s\S]*?setSettingsMessage\([^;]+, "error"\);[\s\S]*?return;/,
  );
  assert.match(populateSettingsSource, /if \(!configState\) \{[\s\S]*?useSystemConfig\.checked = false;[\s\S]*?toggleCustomSettings\(\);/);
  assert.match(taskpaneJs, /const protocols = configState\?\.protocols\?\.length[\s\S]*?SUPPORTED_PROTOCOLS;/);
  assert.match(taskpaneJs, /renderSettingsModels\(configState\?\.settings\?\.model \?\? null\);/);
  assert.match(taskpaneJs, /elements\.settingsButton\.disabled = busy;/);
});

test("设置页提供 Codex 与 Claude CLI 来源选择", () => {
  assert.match(taskpaneHtml, /使用系统 CLI 配置/);
  assert.match(taskpaneHtml, /Codex 或 Claude CLI 配置/);
  assert.match(taskpaneHtml, /id="system-config-source"/);
  assert.match(taskpaneJs, /id: "auto", label: "自动（优先 Codex CLI）"/);
  assert.match(taskpaneJs, /id: "codex", label: "Codex CLI"/);
  assert.match(taskpaneJs, /id: "claude", label: "Claude CLI"/);
  assert.match(taskpaneJs, /systemSource: elements\.systemConfigSource\.value/);
});

test("系统配置摘要和 CLI 来源在窄窗格中保持清晰布局", () => {
  assert.match(taskpaneHtml, /class="system-source-field"/);
  assert.match(taskpaneCss, /\.system-summary\s*\{[\s\S]*?gap:\s*8px;/);
  assert.match(taskpaneCss, /\.system-summary strong,\s*\.system-summary span\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/);
  assert.match(taskpaneCss, /\.system-source-field\s*\{[\s\S]*?display:\s*grid;[\s\S]*?gap:\s*5px;/);
  assert.match(taskpaneCss, /#system-config-source\s*\{[\s\S]*?width:\s*100%;/);
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
