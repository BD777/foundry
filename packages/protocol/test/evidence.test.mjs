import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateEvidenceModel,
  validateContractContent,
} from "../dist/index.js";
const fixtures = JSON.parse(
  readFileSync(new URL("./evidence-fixtures.json", import.meta.url), "utf8"),
);
for (const fixture of fixtures)
  test(`Evidence schema: ${fixture.name}`, () =>
    assert.equal(
      validateEvidenceModel(fixture.model, fixture.value).length === 0,
      fixture.valid,
    ));
test("empty draft cannot be confirmed", () =>
  assert.notEqual(validateContractContent(fixtures[0].value, true).length, 0));
test("confirmed contracts require observable criteria and exact human confirmation", () => {
  const actor = { kind: "local_owner", id: "owner", displayName: "Owner" };
  const digest = `sha256:${"a".repeat(64)}`;
  const c = {
    ...structuredClone(fixtures[3].value),
    schemaVersion: 1,
    id: "contract",
    workspaceId: "ws",
    issueId: "issue",
    createdAt: "2026-09-10T00:00:00Z",
    createdBy: actor,
    revision: 1,
    origin: "user",
    status: "confirmed",
    contentDigest: digest,
    confirmation: { actor, at: "2026-09-10T00:00:00Z", contentDigest: digest },
  };
  assert.deepEqual(validateEvidenceModel("IssueContract", c), []);
  for (const change of [
    { confirmation: undefined },
    { criteria: [] },
    { status: "draft" },
    {
      confirmation: {
        ...c.confirmation,
        contentDigest: `sha256:${"b".repeat(64)}`,
      },
    },
    {
      confirmation: { ...c.confirmation, actor: { ...actor, kind: "daemon" } },
    },
  ])
    assert.ok(
      validateEvidenceModel("IssueContract", { ...c, ...change }).length,
    );
});
test("deterministic criteria reject human-attested binding", () => {
  const content = structuredClone(fixtures[3].value);
  content.criteria[0].evaluationMode = "deterministic";
  content.criteria[0].evidenceRequirements[0].bindingPolicy =
    "system_or_human_attested";
  assert.notEqual(validateEvidenceModel("ContractContent", content).length, 0);
});
test("go and typescript schemas are identical", () => {
  assert.equal(
    readFileSync(
      new URL("../src/evidence-schema.json", import.meta.url),
      "utf8",
    ),
    readFileSync(
      new URL(
        "../../../apps/server/internal/store/evidence-schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});
