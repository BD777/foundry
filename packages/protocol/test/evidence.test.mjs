import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateEvidenceModel } from "../dist/index.js";
const fixtures = JSON.parse(
  readFileSync(new URL("./evidence-fixtures.json", import.meta.url), "utf8"),
);
// A fixture the schema admits but the server's rules reject is `schemaValid`;
// those rules are tested in Go (apps/server/internal/store).
for (const fixture of fixtures)
  test(`Evidence schema: ${fixture.name}`, () =>
    assert.equal(
      validateEvidenceModel(fixture.model, fixture.value).length === 0,
      fixture.schemaValid ?? fixture.valid,
    ));
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
