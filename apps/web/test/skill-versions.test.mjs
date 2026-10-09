import assert from "node:assert/strict";
import { test } from "node:test";
import {
  automaticSkillResolution,
  skillResolutionProblem,
  skillServerLabel,
} from "../src/components/skills/skill-version-state.ts";
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
test("publication decides by itself only when there is nothing to choose", () => {
  // Not in the library: added as a new skill.
  assert.equal(automaticSkillResolution(source).action, "create");
  // The library holds the same content: reused.
  const reusable = {
    ...source,
    serverState: "reusable",
    serverCandidates: [target],
  };
  assert.equal(automaticSkillResolution(reusable).action, "reuse");
  // A same-named entry with other content: the person chooses.
  const conflict = {
    ...reusable,
    serverState: "name_conflict",
    sourceDigest: "different",
  };
  assert.equal(automaticSkillResolution(conflict), undefined);
  assert.match(skillResolutionProblem(conflict, undefined), /choose/i);
  // Even this device's own earlier entry is never overwritten silently.
  const linked = {
    ...conflict,
    promotedSkillId: "id",
    serverState: "different",
    serverRevision: 2,
  };
  assert.equal(automaticSkillResolution(linked), undefined);
  assert.equal(
    skillResolutionProblem(linked, {
      root: "/skills",
      dirName: "alpha",
      action: "keep",
      targetSkillId: "id",
      expectedRevision: 2,
    }),
    undefined,
  );
  assert.equal(skillServerLabel(linked), "Local differs · rev 2");
  assert.ok(skillResolutionProblem(source, { action: "fork", name: "alpha" }));
});
test("mature diff engine produces renderable hunks and bounds pathological files", () => {
  const result = createFileDiff("first\nold\nlast\n", "first\nnew\nlast\n");
  const changes = parseDiff(result.patch)[0].hunks.flatMap((h) => h.changes);
  assert.ok(changes.some((c) => c.type === "delete" && c.content === "old"));
  assert.ok(changes.some((c) => c.type === "insert" && c.content === "new"));
  assert.equal(createFileDiff("x".repeat(30000), "y").error, "longLines");
  assert.equal(
    parseDiff(createFileDiff("same\n", "same\n").patch)[0].hunks.length,
    0,
  );
});
