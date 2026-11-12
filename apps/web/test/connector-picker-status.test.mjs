import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const { serverHeldStatus } =
  await import("../src/features/external-accounts/connector-picker.tsx");

test("a server-held extension with a Ready instance shows as connected", () => {
  assert.equal(
    serverHeldStatus("openlark", [], [{ id: "i1", status: "ready" }]),
    "connected",
  );
  assert.equal(
    serverHeldStatus("openlark", [], [{ id: "i1", status: "expiring" }]),
    "connected",
  );
});

test("instances that are not Ready need attention; none means not set up", () => {
  assert.equal(
    serverHeldStatus("openlark", [], [{ id: "i1", status: "revoked" }]),
    "needsSignIn",
  );
  assert.equal(serverHeldStatus("openlark", [], []), "notSetUp");
});

test("connectors without instances still follow their accounts", () => {
  assert.equal(
    serverHeldStatus("cloudflare", [
      { provider: "cloudflare", status: "ready" },
    ]),
    "connected",
  );
  assert.equal(serverHeldStatus("cloudflare", undefined), undefined);
});
