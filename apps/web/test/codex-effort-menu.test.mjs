import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const { catalogModel, codexEffortOptions, effortLabel } =
  await import("../src/lib/agent-effort.ts");
const { mergeModelOptionLists } = await import("../src/lib/model-options.ts");
const { describeModelAndEffort } =
  await import("../src/components/agent-runtime/agent-runtime-labels.ts");

// Shaped as the Worker reports Codex 0.163.0's model/list for the account.
const astra = {
  id: "gpt-6-astra",
  label: "GPT-6-Astra",
  isDefault: true,
  defaultReasoningEffort: "medium",
  reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
};
const luna = {
  id: "gpt-6-luna",
  label: "GPT-6-Luna",
  defaultReasoningEffort: "medium",
  reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
};
const endpointModel = { id: "relay/opaque-model" };
const catalog = [astra, luna, endpointModel];

const values = (options) => options.map((option) => option.value);

test("a Codex model offers exactly the efforts its catalog lists, in order", () => {
  assert.deepEqual(values(codexEffortOptions(astra)), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  assert.deepEqual(values(codexEffortOptions(luna)), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("a model whose catalog names no efforts offers none", () => {
  assert.deepEqual(codexEffortOptions(endpointModel), []);
  assert.deepEqual(codexEffortOptions(undefined), []);
});

test("every offered effort has a label that is not a missing key", () => {
  for (const option of codexEffortOptions(astra)) {
    assert.equal(option.label.startsWith("agents:"), false, option.value);
    assert.notEqual(option.label, "", option.value);
  }
});

test("an effort with no label of its own shows as its name", () => {
  assert.equal(effortLabel("turbo"), "turbo");
});

test("a blank model choice means the account's default model", () => {
  assert.equal(catalogModel(catalog, ""), astra);
  assert.equal(catalogModel(catalog, "gpt-6-luna"), luna);
  assert.equal(catalogModel(catalog, "unlisted"), undefined);
});

test("the menu for the selected Codex model lists its efforts", () => {
  const view = describeModelAndEffort({
    runtime: "codex",
    claudeEffort: "",
    codexReasoningEffort: "ultra",
    modelLoadFailed: false,
    modelLoading: false,
    modelOptions: catalog,
    modelValue: "gpt-6-astra",
  });
  assert.deepEqual(values(view.effortOptions), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  assert.equal(view.effortValue, "ultra");
});

test("an unset Codex effort shows the model's default, not a made-up one", () => {
  const view = describeModelAndEffort({
    runtime: "codex",
    claudeEffort: "",
    codexReasoningEffort: "",
    modelLoadFailed: false,
    modelLoading: false,
    modelOptions: catalog,
    modelValue: "gpt-6-luna",
  });
  assert.equal(view.effortValue, "medium");
});

test("a saved effort the model no longer lists still shows honestly", () => {
  const view = describeModelAndEffort({
    runtime: "codex",
    claudeEffort: "",
    codexReasoningEffort: "minimal",
    modelLoadFailed: false,
    modelLoading: false,
    modelOptions: catalog,
    modelValue: "gpt-6-astra",
  });
  assert.equal(view.effortValue, "minimal");
  assert.equal(view.effortLabel, effortLabel("minimal"));
  assert.equal(values(view.effortOptions).includes("minimal"), false);
});

test("a configured model keeps the efforts its discovered entry reports", () => {
  const merged = mergeModelOptionLists(
    ["gpt-6-astra", "custom"],
    [astra, luna],
  );
  assert.deepEqual(
    merged.map((model) => model.id),
    ["gpt-6-astra", "custom", "gpt-6-luna"],
  );
  assert.deepEqual(merged[0], astra);
  assert.deepEqual(merged[1], { id: "custom" });
});
