import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { enforceAuditBaseline } from "./audit-baseline.mjs";

const appPath = resolve("src/App.tsx");
const source = readFileSync(appPath, "utf8");
const failures = [];

function lineFor(index) {
  return source.slice(0, index).split("\n").length;
}

const checks = [
  {
    pattern: /\bfdy-[A-Za-z0-9_-]+/g,
    reason: "App.tsx must not reference Foundry visual class tokens directly",
  },
  {
    pattern: /\bclassName\s*=/g,
    reason:
      "App.tsx must compose Foundry UI components instead of direct className styling",
  },
  {
    pattern: /\bendClassName\s*=/g,
    reason:
      "App.tsx must use component-level visual props instead of className escape hatches",
  },
  {
    pattern: /\bstyle\s*=/g,
    reason: "App.tsx must not use inline style escape hatches",
  },
];

for (const check of checks) {
  for (const match of source.matchAll(check.pattern)) {
    failures.push({
      line: lineFor(match.index ?? 0),
      path: "App.tsx",
      reason: check.reason,
      token: match[0],
    });
  }
}

enforceAuditBaseline({
  auditName: "app-boundary",
  failureLabel: "App boundary",
  failures,
  signature: (failure) => `${failure.reason}|${failure.token}`,
});
