import test from "node:test";
import assert from "node:assert/strict";
import { withDispatchCredential } from "../dist/profiles.js";

test("a dispatched credential overrides the local profile key for the run", () => {
  const local = {
    id: "prof_1",
    runtime: "claude",
    label: "Relay",
    apiKey: "local-key",
    baseUrl: "https://relay.example",
  };
  const overridden = withDispatchCredential(local, " server-key ");
  assert.equal(overridden.apiKey, "server-key");
  // The run is now credentialed by the control plane, which is what the
  // projection reports as secretStored.
  assert.equal(overridden.origin, "server");
  // The local profile object itself stays untouched.
  assert.equal(local.apiKey, "local-key");
  assert.equal(overridden.baseUrl, local.baseUrl);
});

test("no dispatched credential keeps the local key and object identity", () => {
  const local = {
    id: "prof_1",
    runtime: "codex",
    label: "Local",
    apiKey: "local-key",
  };
  assert.equal(withDispatchCredential(local, undefined), local);
  assert.equal(local.origin, undefined);
  assert.equal(withDispatchCredential(local, ""), local);
  assert.equal(withDispatchCredential(local, "   "), local);
  // A profile without a local key gains none from an absent dispatch.
  const bare = { id: "prof_2", runtime: "claude", label: "Bare" };
  assert.equal(withDispatchCredential(bare, undefined), bare);
});
