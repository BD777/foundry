import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const { mergeDiscoveredModels } =
  await import("../src/components/ui/model-combobox.tsx");
const { mergeModelOptionLists } =
  await import("../src/features/chat/model-options.ts");

test("discovery adds models without disturbing curated entries", () => {
  assert.deepEqual(
    mergeDiscoveredModels(
      ["model_hub/es1_orange_o50", "gpt-6-astra"],
      ["gpt-6-astra", "gpt-5.6-sol"],
    ),
    ["model_hub/es1_orange_o50", "gpt-6-astra", "gpt-5.6-sol"],
  );
});

test("blank discoveries never enter the list", () => {
  assert.deepEqual(mergeDiscoveredModels(["kept"], ["  ", ""]), ["kept"]);
});

test("a run offers the profile list first, then discovery", () => {
  assert.deepEqual(
    mergeModelOptionLists(
      ["model_hub/es1"],
      [{ id: "gpt-6-astra", label: "GPT-6-Astra" }, { id: "model_hub/es1" }],
    ),
    [{ id: "model_hub/es1" }, { id: "gpt-6-astra", label: "GPT-6-Astra" }],
  );
});

test("a profile with no list still offers whatever was discovered", () => {
  assert.deepEqual(mergeModelOptionLists([], [{ id: "gpt-6-astra" }]), [
    { id: "gpt-6-astra" },
  ]);
});
