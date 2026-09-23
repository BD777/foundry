import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);
const { environmentCounts, repositoryState } =
  await import("../src/features/issue-detail/environment-model.ts");
const { diagnosticSummary } = await import("../src/lib/diagnostic-summary.ts");

test("registration availability never implies a prepared Issue candidate, including old server payloads", () => {
  const repositories = [
    { path: "a", status: "ready" },
    { path: "b", status: "unavailable", error: "Initialize submodule" },
  ];
  assert.deepEqual(
    environmentCounts({ status: "not_prepared", repositories }),
    { registered: 2, prepared: 0, unavailable: 1 },
  );
  assert.deepEqual(
    repositoryState(
      { path: "a", status: "unprepared", availability: "ready" },
      "not_prepared",
    ),
    { candidate: "unprepared", availability: "ready", unavailable: false },
  );
  assert.deepEqual(
    environmentCounts({
      status: "review",
      repositories: [
        { path: ".", status: "ready", availability: "ready" },
        { path: "child", status: "unprepared", availability: "ready" },
      ],
    }),
    { registered: 2, prepared: 1, unavailable: 0 },
  );
});
test("large diagnostics retain the complete original under a concise summary", () => {
  const original =
    "Repository discovery must finish before initialization: " +
    "child/vendor: Submodule is not initialized; ".repeat(39);
  const result = diagnosticSummary(original);
  assert.ok(result.summary.length < 250);
  assert.match(result.summary, /39 uninitialized submodules/);
  assert.equal(result.details, original);
  assert.deepEqual(diagnosticSummary("Device offline"), {
    summary: "Device offline",
  });
});
