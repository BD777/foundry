import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeProviderBaseUrl } from "../dist/index.js";

// Shared with the server (provider_endpoint_test.go): both sides apply the
// same rules, so the web preview is what the server saves.
const fixtures = JSON.parse(
  readFileSync(new URL("./provider-endpoint-fixtures.json", import.meta.url)),
);

for (const fixture of fixtures) {
  test(fixture.name, () => {
    const result = normalizeProviderBaseUrl(fixture.runtime, fixture.input, {
      addMissingVersion: fixture.addMissingVersion,
    });
    if (fixture.error) {
      assert.deepEqual(result, { error: fixture.error });
      return;
    }
    assert.deepEqual(result, {
      baseUrl: fixture.baseUrl,
      corrections: fixture.corrections,
    });
  });
}
