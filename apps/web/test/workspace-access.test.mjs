import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { workspaceDenial } = await import("../src/lib/workspace-access.ts");

test("workspace denial names the caller's role and the role an action needs", () => {
  assert.equal(
    workspaceDenial({ accessRole: "viewer" }, "member"),
    "You are a Viewer in this workspace; this needs Member or higher.",
  );
  assert.equal(workspaceDenial({ accessRole: "member" }, "member"), undefined);
  assert.equal(
    workspaceDenial({ accessRole: "owner" }, "maintainer"),
    undefined,
  );
  assert.match(
    workspaceDenial({ accessRole: "maintainer" }, "owner") ?? "",
    /Maintainer.*needs Owner/,
  );
});

test("a workspace without a role leaves the decision to the server", () => {
  assert.equal(workspaceDenial({}, "owner"), undefined);
  assert.equal(workspaceDenial(undefined, "member"), undefined);
});
