import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeReasoningModel,
  reasoningEffortDisplayName,
  reasoningEffortLevel,
  reasoningEffortMenuValues,
  reconcileReasoningEffort,
  selectableReasoningEfforts,
} from "../src/taskpane/model-selection.js";

test("缺失思考能力字段时规范为空数组，不伪造关闭档位", () => {
  const model = normalizeReasoningModel({ id: "id-only" });

  assert.deepEqual(model.reasoningEfforts, []);
  assert.deepEqual(model.compatibleReasoningEfforts, []);
  assert.equal(model.defaultReasoningEffort, null);
  assert.equal(model.reasoningEfforts.includes("none"), false);
});

test("兼容模型在菜单中提供自动和保守兼容档位", () => {
  const model = normalizeReasoningModel({
    id: "gateway-id-only",
    reasoningEfforts: [],
    compatibleReasoningEfforts: ["low", "medium", "high"],
  });

  assert.deepEqual(selectableReasoningEfforts(model), ["low", "medium", "high"]);
  assert.deepEqual(reasoningEffortMenuValues(model), [null, "low", "medium", "high"]);
});

test("Qwen thinking-toggle 显示自动和关闭，官方 levels 不自动增加自动项", () => {
  const qwenChat = normalizeReasoningModel({
    id: "qwen3.7-max",
    reasoningMode: "thinking-toggle",
    reasoningEfforts: ["none"],
    defaultReasoningEffort: null,
  });
  const qwenResponses = normalizeReasoningModel({
    id: "qwen3.7-max",
    reasoningMode: "levels",
    reasoningEfforts: ["none", "minimal", "low", "medium", "high"],
    defaultReasoningEffort: "medium",
  });

  assert.deepEqual(reasoningEffortMenuValues(qwenChat), [null, "none"]);
  assert.deepEqual(reasoningEffortMenuValues(qwenResponses), ["none", "minimal", "low", "medium", "high"]);
  assert.equal(reasoningEffortMenuValues(qwenResponses).includes(null), false);
});

test("切换模型时无效旧选择优先回到官方默认，而不是首项关闭", () => {
  const model = normalizeReasoningModel({
    id: "qwen3.7-max",
    reasoningMode: "levels",
    reasoningEfforts: ["none", "minimal", "low", "medium", "high"],
    defaultReasoningEffort: "medium",
  });

  assert.equal(reconcileReasoningEffort({
    model,
    selectedEffort: "max",
    configuredModelId: "other-model",
    configuredEffort: "high",
  }), "medium");
});

test("刷新后兼容档位失效回到自动，当前配置中的有效值仍可恢复", () => {
  const compatibleModel = normalizeReasoningModel({
    id: "gateway-id-only",
    reasoningEfforts: [],
    compatibleReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: null,
  });
  const configuredModel = normalizeReasoningModel({
    id: "configured-model",
    reasoningEfforts: ["none", "low", "high"],
    defaultReasoningEffort: null,
  });

  assert.equal(reconcileReasoningEffort({
    model: compatibleModel,
    selectedEffort: "xhigh",
    configuredModelId: "gateway-id-only",
    configuredEffort: "xhigh",
  }), null);
  assert.equal(reconcileReasoningEffort({
    model: configuredModel,
    selectedEffort: "xhigh",
    configuredModelId: "configured-model",
    configuredEffort: "high",
  }), "high");
});

test("思考档位中文名称和等级可唯一辨认", () => {
  const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const names = efforts.map(reasoningEffortDisplayName);
  const levels = efforts.map(reasoningEffortLevel);

  assert.deepEqual(names, ["最低", "低", "中", "高", "极高", "最高"]);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(levels, ["1", "2", "3", "4", "5", "6"]);
  assert.equal(new Set(levels).size, levels.length);
  assert.equal(reasoningEffortLevel(null), "0");
  assert.equal(reasoningEffortLevel("none"), "0");
});
