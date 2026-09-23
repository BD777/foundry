import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultSkillResolution,
  skillResolutionProblem,
  skillServerLabel,
} from "../src/features/devices/skill-version-state.ts";
import { createFileDiff } from "../src/components/ui/file-diff-engine.ts";
import { parseDiff } from "react-diff-view";
const source = {
  name: "alpha",
  root: "/skills",
  dirName: "alpha",
  sourceDigest: "same",
  serverState: "unpublished",
};
const target = {
  id: "id",
  name: "alpha",
  sourceDigest: "same",
  latestRevision: 2,
};
test("default publication reuses identical content and makes name conflicts explicit", () => {
  assert.equal(defaultSkillResolution(source).action, "create");
  const reusable = {
    ...source,
    serverState: "reusable",
    serverCandidates: [target],
  };
  assert.equal(defaultSkillResolution(reusable).action, "reuse");
  const conflict = {
    ...reusable,
    serverState: "name_conflict",
    sourceDigest: "different",
  };
  assert.match(
    skillResolutionProblem(conflict, defaultSkillResolution(conflict)),
    /Choose/,
  );
  const linked = {
    ...conflict,
    promotedSkillId: "id",
    serverState: "different",
    serverRevision: 2,
  };
  assert.deepEqual(defaultSkillResolution(linked), {
    root: "/skills",
    dirName: "alpha",
    action: "update",
    targetSkillId: "id",
    expectedRevision: 2,
  });
  assert.equal(skillServerLabel(linked), "Local differs · rev 2");
  assert.ok(skillResolutionProblem(source, { action: "fork", name: "alpha" }));
});
test("mature diff engine produces renderable hunks and bounds pathological files", () => {
  const result = createFileDiff("first\nold\nlast\n", "first\nnew\nlast\n");
  const changes = parseDiff(result.patch)[0].hunks.flatMap((h) => h.changes);
  assert.ok(changes.some((c) => c.type === "delete" && c.content === "old"));
  assert.ok(changes.some((c) => c.type === "insert" && c.content === "new"));
  assert.match(createFileDiff("x".repeat(30000), "y").error, /long lines/);
  assert.equal(
    parseDiff(createFileDiff("same\n", "same\n").patch)[0].hunks.length,
    0,
  );
});
