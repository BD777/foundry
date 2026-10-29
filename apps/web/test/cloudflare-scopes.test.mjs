import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);
const {
  groupCloudflareScopes,
  summarizeCloudflareScopes,
  isCloudflareWriteScope,
} = await import("../src/features/external-accounts/cloudflare-scopes.ts");

const requested = [
  "offline_access",
  "user:read",
  "account:read",
  "zone.read",
  "dns.read",
  "ssl-and-certificates.read",
];
// Synthetic "all permissions" grant: never a real account's list.
const broad = [
  ...requested,
  "dns_records:edit",
  "workers_scripts:write",
  "workers_scripts:read",
  "access.read",
  "access.write",
];

test("summary counts asked, granted and write permissions", () => {
  assert.deepEqual(summarizeCloudflareScopes(requested, requested), {
    asked: 5,
    granted: 5,
    write: 0,
  });
  assert.deepEqual(summarizeCloudflareScopes(broad, requested), {
    asked: 5,
    granted: 10,
    write: 3,
  });
  assert.equal(summarizeCloudflareScopes(broad, undefined).asked, 0);
  assert.equal(isCloudflareWriteScope("offline_access"), false);
  assert.equal(isCloudflareWriteScope("dns_records:edit"), true);
});

test("groups by product area with read before write", () => {
  const groups = groupCloudflareScopes(broad);
  const labels = groups.map((g) => g.label);
  assert.deepEqual(labels, [
    "Access",
    "Account",
    "DNS",
    "SSL and Certificates",
    "User",
    "Workers",
    "Zone",
  ]);
  const workers = groups.find((g) => g.area === "workers");
  assert.deepEqual(workers.resources, [
    { name: "workers_scripts", actions: ["read", "write"] },
  ]);
  const dns = groups.find((g) => g.area === "dns");
  assert.deepEqual(
    dns.resources.map((r) => r.name),
    ["dns", "dns_records"],
  );
  assert.deepEqual(
    groupCloudflareScopes(broad, "worker").map((g) => g.area),
    ["workers"],
  );
  assert.equal(groupCloudflareScopes(broad, "nothing-matches").length, 0);
});
