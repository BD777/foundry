import test from "node:test";
import assert from "node:assert/strict";
import {
  codexBundledCatalogOption,
  codexModelListOption,
} from "../dist/harness/native/native-inspection.js";

// Shapes as Codex 0.163.0 answers them: `model/list` rows and `codex debug
// models --bundled` rows, with the efforts each model advertises in order.
test("a model/list row keeps every effort its model advertises, in order", () => {
  const option = codexModelListOption({
    model: "gpt-6-astra",
    displayName: "GPT-6-Astra",
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "" },
      { reasoningEffort: "medium", description: "" },
      { reasoningEffort: "high", description: "" },
      { reasoningEffort: "xhigh", description: "" },
      { reasoningEffort: "max", description: "" },
      { reasoningEffort: "ultra", description: "" },
    ],
  });
  assert.deepEqual(option, {
    id: "gpt-6-astra",
    label: "GPT-6-Astra",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningEffort: "medium",
    isDefault: true,
  });
});

test("a model that advertises fewer efforts is not padded with others", () => {
  const option = codexModelListOption({
    model: "gpt-5.5",
    displayName: "GPT-5.5",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map(
      (reasoningEffort) => ({ reasoningEffort, description: "" }),
    ),
  });
  assert.deepEqual(option.reasoningEfforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(option.reasoningEfforts.includes("minimal"), false);
});

test("a row that states no efforts claims none", () => {
  assert.deepEqual(
    codexModelListOption({ model: "opaque", displayName: "Opaque" }),
    {
      id: "opaque",
      label: "Opaque",
    },
  );
  const blanks = codexModelListOption({
    model: "blank",
    supportedReasoningEfforts: [{ reasoningEffort: "" }],
  });
  assert.equal("reasoningEfforts" in blanks, false);
});

test("a bundled-catalog row maps its levels the same way", () => {
  const option = codexBundledCatalogOption({
    slug: "gpt-6-luna",
    display_name: "GPT-6-Luna",
    visibility: "list",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low" },
      { effort: "medium" },
      { effort: "high" },
      { effort: "xhigh" },
      { effort: "max" },
    ],
  });
  assert.deepEqual(option, {
    id: "gpt-6-luna",
    label: "GPT-6-Luna",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  });
});
