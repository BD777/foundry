import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const { domainForMember, domainStatus, memberTier } =
  await import("../src/features/profiles/worker-group-domain.ts");
const { profiles: en } = await import("../src/i18n/locales/en/profiles.ts");
const { profiles: zh } = await import("../src/i18n/locales/zh-CN/profiles.ts");

const NOW = Date.parse("2026-11-17T00:00:00Z");
const domain = (patch) => ({
  profileId: "p1",
  runtime: "codex",
  state: "healthy",
  level: 0,
  limit: 4,
  active: 2,
  signalsInWindow: 0,
  failoversLastHour: 0,
  ...patch,
});

function keysOf(value, prefix = "") {
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === "object"
      ? keysOf(child, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

test("a member without a tier is primary; tier 2 is the fallback", () => {
  assert.equal(memberTier({}), 1);
  assert.equal(memberTier({ tier: 1 }), 1);
  assert.equal(memberTier({ tier: 2 }), 2);
});

test("a member's domain is its account and runtime, not the account alone", () => {
  const domains = [
    domain({ profileId: "p1", runtime: "codex" }),
    domain({ profileId: "p1", runtime: "claude" }),
  ];
  assert.equal(
    domainForMember(domains, { providerId: "p1", runtime: "claude" }),
    domains[1],
  );
  assert.equal(
    domainForMember(domains, { providerId: "p2", runtime: "codex" }),
    undefined,
  );
});

test("each domain state maps to its status key and values", () => {
  assert.deepEqual(domainStatus(domain({ state: "healthy" }), NOW), {
    state: "healthy",
    key: "workerGroups.domain.healthy",
    values: { active: 2, limit: 4, minutes: 0 },
    failoversLastHour: 0,
  });
  assert.equal(
    domainStatus(domain({ state: "probing" }), NOW).key,
    "workerGroups.domain.probing",
  );
  assert.equal(
    domainStatus(domain({ state: "recovering" }), NOW).key,
    "workerGroups.domain.recovering",
  );
});

test("a limited domain rounds the cooldown up to whole minutes and carries its failovers", () => {
  const status = domainStatus(
    domain({
      state: "limited",
      cooldownUntil: new Date(NOW + 5.5 * 60_000).toISOString(),
      failoversLastHour: 3,
    }),
    NOW,
  );
  assert.equal(status.key, "workerGroups.domain.limited");
  assert.equal(status.values.minutes, 6);
  assert.equal(status.failoversLastHour, 3);
});

test("a limited domain without a future cooldown says so without minutes", () => {
  const past = new Date(NOW - 60_000).toISOString();
  assert.equal(
    domainStatus(domain({ state: "limited" }), NOW).key,
    "workerGroups.domain.limitedNoEta",
  );
  assert.equal(
    domainStatus(domain({ state: "limited", cooldownUntil: past }), NOW).key,
    "workerGroups.domain.limitedNoEta",
  );
  assert.equal(
    domainStatus(domain({ state: "limited", cooldownUntil: "not a time" }), NOW)
      .values.minutes,
    0,
  );
});

test("both locales define every worker group domain label", () => {
  const keys = (locale) =>
    keysOf(locale.workerGroups).filter((key) => key.startsWith("domain."));
  assert.deepEqual(keys(zh).sort(), keys(en).sort());
  assert.equal(keys(en).length, 10);
});

test("an account the server reports unusable names its cause in both locales", () => {
  const causes = {
    402: "workerGroups.domain.unusableArrears",
    "quota exhausted": "workerGroups.domain.unusableQuota",
    "account disabled": "workerGroups.domain.unusableDisabled",
    "something new": "workerGroups.domain.unusableOther",
  };
  for (const [reason, key] of Object.entries(causes)) {
    const status = domainStatus(domain({ state: "limited", reason }), NOW);
    assert.equal(status.key, key);
    assert.equal(status.values.reason, reason);
    const shortKey = key.replace("workerGroups.domain.", "");
    assert.ok(en.workerGroups.domain[shortKey], `en ${shortKey}`);
    assert.ok(zh.workerGroups.domain[shortKey], `zh ${shortKey}`);
    assert.notEqual(
      zh.workerGroups.domain[shortKey],
      en.workerGroups.domain[shortKey],
    );
  }
});

test("a probing account with a reason still shows the unusable cause", () => {
  assert.equal(
    domainStatus(domain({ state: "probing", reason: "402" }), NOW).key,
    "workerGroups.domain.unusableArrears",
  );
});
