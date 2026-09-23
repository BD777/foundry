import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const baselinePath = resolve(scriptDirectory, "audit-baseline.json");

export function enforceAuditBaseline({
  auditName,
  failureLabel,
  failures,
  signature,
}) {
  const snapshot = baselineSnapshot(failures, signature);
  if (process.env.FOUNDRY_AUDIT_PRINT_BASELINE === "1") {
    console.log(JSON.stringify({ [auditName]: snapshot }, null, 2));
    return;
  }

  const baseline = readBaseline();
  const expected = baseline[auditName];
  if (process.env.FOUNDRY_AUDIT_UPDATE === "1") {
    updateBaseline({ auditName, baseline, expected, snapshot });
    return;
  }

  if (
    expected &&
    expected.count === snapshot.count &&
    expected.hash === snapshot.hash
  ) {
    console.log(
      `${failureLabel} audit passed with ${snapshot.count} tracked debt item${snapshot.count === 1 ? "" : "s"}.`,
    );
    return;
  }

  console.error(`${failureLabel} audit failed:`);
  if (!expected) {
    console.error(
      `- Missing scripts/audit-baseline.json entry for "${auditName}".`,
    );
  } else if (snapshot.count > expected.count) {
    console.error(
      `- Audit debt increased from ${expected.count} to ${snapshot.count}.`,
    );
  } else if (snapshot.count < expected.count) {
    console.error(
      `- Audit debt decreased from ${expected.count} to ${snapshot.count}; shrink the checked-in baseline.`,
    );
  } else {
    console.error(
      `- Audit debt changed without decreasing (${snapshot.count} items).`,
    );
  }
  for (const failure of failures) {
    const detail = failure.token
      ? `${failure.reason}: ${failure.token}`
      : failure.reason;
    console.error(
      `- ${failure.path ? `src/${failure.path}:` : "src/styles.css:"}${failure.line} ${detail}`,
    );
  }
  console.error(
    "- Run pnpm audit:baseline:update after intentionally reducing debt.",
  );
  process.exit(1);
}

function baselineSnapshot(failures, signature) {
  const signatures = failures.map(signature).sort();
  return {
    count: signatures.length,
    hash: createHash("sha256").update(JSON.stringify(signatures)).digest("hex"),
  };
}

function readBaseline() {
  return JSON.parse(readFileSync(baselinePath, "utf8"));
}

function updateBaseline({ auditName, baseline, expected, snapshot }) {
  const allowIncrease = process.env.FOUNDRY_AUDIT_ALLOW_INCREASE === "1";
  const allowSameCountChange =
    process.env.FOUNDRY_AUDIT_ALLOW_SAME_COUNT_CHANGE === "1";
  if (expected && snapshot.count > expected.count && !allowIncrease) {
    console.error(
      `${auditName} baseline update refused: debt increased from ${expected.count} to ${snapshot.count}.`,
    );
    process.exit(1);
  }
  if (
    expected &&
    snapshot.count === expected.count &&
    snapshot.hash !== expected.hash &&
    !allowSameCountChange
  ) {
    console.error(
      `${auditName} baseline update refused: the violation set changed without decreasing.`,
    );
    process.exit(1);
  }

  baseline[auditName] = snapshot;
  const sorted = Object.fromEntries(
    Object.entries(baseline).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(
    `${auditName} baseline updated to ${snapshot.count} tracked debt item${snapshot.count === 1 ? "" : "s"}.`,
  );
}
