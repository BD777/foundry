import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveSkillSelection,
  toggleSkillSelection,
} from "../src/components/skills/skill-selection-engine.ts";

const mockSkill = (id, name, dependencies = []) => ({
  id,
  name,
  description: `Description of ${name}`,
  subtitle: `Sub ${name}`,
  path: `/skills/${name}`,
  kind: "promoted",
  dependencies,
});

const dep = (name, strength = "required") => ({
  skillName: name,
  strength,
  evidence: `SKILL.md:1 use ${name}`,
});

test("selecting a skill auto-enables required dependencies and default-enables related skills", () => {
  const catalog = [
    mockSkill("id-a", "skill-a", [
      dep("skill-b", "required"),
      dep("skill-c", "related"),
    ]),
    mockSkill("id-b", "skill-b"),
    mockSkill("id-c", "skill-c"),
    mockSkill("id-d", "skill-d"),
  ];

  const resolution = resolveSkillSelection(catalog, new Set(["id-a"]));

  // All of a, b, and c should be selected
  assert.equal(resolution.selectedIds.has("id-a"), true);
  assert.equal(resolution.selectedIds.has("id-b"), true);
  assert.equal(resolution.selectedIds.has("id-c"), true);
  assert.equal(resolution.selectedIds.has("id-d"), false);

  // Auto-activated ids are b and c
  assert.equal(resolution.autoActivatedIds.has("id-b"), true);
  assert.equal(resolution.autoActivatedIds.has("id-c"), true);
  assert.equal(resolution.autoActivatedIds.has("id-a"), false);

  // Required and related records
  assert.deepEqual(resolution.requiredBy.get("id-b"), ["skill-a"]);
  assert.deepEqual(resolution.relatedTo.get("id-c"), ["skill-a"]);
});

test("transitive closure: related skill brings its own required dependencies", () => {
  const catalog = [
    mockSkill("id-a", "skill-a", [dep("skill-b", "related")]),
    mockSkill("id-b", "skill-b", [dep("skill-d", "required")]),
    mockSkill("id-d", "skill-d"),
  ];

  const resolution = resolveSkillSelection(catalog, new Set(["id-a"]));
  assert.deepEqual([...resolution.selectedIds].sort(), [
    "id-a",
    "id-b",
    "id-d",
  ]);
});

test("handles cycles without infinite loop", () => {
  const catalog = [
    mockSkill("id-a", "skill-a", [dep("skill-b", "required")]),
    mockSkill("id-b", "skill-b", [dep("skill-a", "required")]),
  ];

  const resolution = resolveSkillSelection(catalog, new Set(["id-a"]));
  assert.deepEqual([...resolution.selectedIds].sort(), ["id-a", "id-b"]);
});

test("toggle ON reports newly auto-activated names for user notification", () => {
  const catalog = [
    mockSkill("id-a", "skill-a", [
      dep("skill-b", "required"),
      dep("skill-c", "related"),
    ]),
    mockSkill("id-b", "skill-b"),
    mockSkill("id-c", "skill-c"),
  ];

  const result = toggleSkillSelection("id-a", catalog, new Set(), new Set());
  assert.equal(result.allowed, true);
  assert.deepEqual(result.newlyActivatedNames.sort(), ["skill-b", "skill-c"]);
  assert.equal(result.resolution.selectedIds.size, 3);
});

test("toggle OFF allows deselecting an auto-enabled related skill", () => {
  const catalog = [
    mockSkill("id-a", "skill-a", [dep("skill-c", "related")]),
    mockSkill("id-c", "skill-c"),
  ];

  // First select a
  const step1 = toggleSkillSelection("id-a", catalog, new Set(), new Set());
  assert.equal(step1.resolution.selectedIds.has("id-c"), true);

  // Now deselect c
  const step2 = toggleSkillSelection(
    "id-c",
    catalog,
    step1.nextExplicit,
    step1.nextDeselectedRelated,
  );
  assert.equal(step2.allowed, true);
  assert.equal(step2.resolution.selectedIds.has("id-a"), true);
  assert.equal(step2.resolution.selectedIds.has("id-c"), false);
  assert.equal(step2.nextDeselectedRelated.has("id-c"), true);
});

test("toggle OFF blocks deselecting a strictly required dependency", () => {
  const catalog = [
    mockSkill("id-a", "skill-a", [dep("skill-b", "required")]),
    mockSkill("id-b", "skill-b"),
  ];

  const step1 = toggleSkillSelection("id-a", catalog, new Set(), new Set());
  assert.equal(step1.resolution.selectedIds.has("id-b"), true);

  // Try to deselect b
  const step2 = toggleSkillSelection(
    "id-b",
    catalog,
    step1.nextExplicit,
    step1.nextDeselectedRelated,
  );
  assert.equal(step2.allowed, false);
  assert.match(step2.blockedReason, /required by skill-a/i);
});

test("surfaces missing required dependencies", () => {
  const catalog = [
    mockSkill("id-a", "skill-a", [dep("non-existent-skill", "required")]),
  ];

  const resolution = resolveSkillSelection(catalog, new Set(["id-a"]));
  const missing = resolution.missingRequired.get("id-a");
  assert.ok(missing);
  assert.equal(missing[0].missingSkillName, "non-existent-skill");
});
