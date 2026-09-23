import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSkillPromotionSelection,
  defaultSkillPromotionReferences,
  sameSkillPromotionSources,
} from "../src/features/devices/skill-promotion-plan.ts";
const skill = (name, dependencies = []) => ({
  deviceId: "device",
  root: "/skills",
  dirName: name,
  name,
  description: "",
  sizeBytes: 1,
  mtimeLabel: "",
  sourceDigest: `hash-${name}`,
  dependenciesAnalyzed: true,
  dependencies,
});
const dep = (name, strength = "required") => ({
  skillName: name,
  targetRoot: "/skills",
  targetDirName: name,
  status: "resolved",
  strength,
  evidence: `SKILL.md:1: use ${name}`,
});

test("saved graph includes A → B → C once, tolerating cycles and diamonds", () => {
  const a = skill("a", [dep("b"), dep("c")]),
    b = skill("b", [dep("c")]),
    c = skill("c", [dep("a")]);
  const result = buildSkillPromotionSelection(a, [a, b, c], []);
  assert.deepEqual(
    result.skills.map((s) => s.name),
    ["a", "b", "c"],
  );
  assert.deepEqual(result.problems, []);
});
test("optional dependencies bring their full required closure, missing nodes block", () => {
  const a = skill("a", [dep("b", "related")]),
    b = skill("b", [dep("c")]),
    c = skill("c");
  assert.equal(buildSkillPromotionSelection(a, [a, b, c], []).skills.length, 1);
  assert.equal(
    buildSkillPromotionSelection(a, [a, b, c], ["b"]).skills.length,
    3,
  );
  assert.equal(
    buildSkillPromotionSelection(a, [a, b], ["b"]).problems.length,
    1,
  );
  assert.equal(sameSkillPromotionSources([a, b], [b, a]), true);
  assert.equal(
    sameSkillPromotionSources([a, b], [a, { ...b, sourceDigest: "changed" }]),
    false,
  );
});
test("large graphs traverse without recursive JS stack growth", () => {
  const nodes = Array.from({ length: 10000 }, (_, i) =>
    skill(String(i), i < 9999 ? [dep(String(i + 1))] : []),
  );
  const result = buildSkillPromotionSelection(nodes[0], nodes, []);
  assert.equal(result.skills.length, 10000);
  assert.deepEqual(result.problems, []);
});

test("default selection includes transitive and unresolved references, stops cycles", () => {
  const a = skill("a", [dep("b", "related")]);
  const b = skill("b", [dep("c", "related"), dep("missing", "related")]);
  const c = skill("c", [dep("a")]);
  const selected = defaultSkillPromotionReferences(a, [a, b, c]);
  assert.deepEqual(selected.sort(), ["b", "c", "missing"]);
  const plan = buildSkillPromotionSelection(a, [a, b, c], selected);
  assert.equal(plan.skills.length, 3);
  assert.equal(plan.problems.length, 1);
});
