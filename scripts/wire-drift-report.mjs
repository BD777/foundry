#!/usr/bin/env node
// Wire drift report (docs/refactor/phase6-openapi-design.md, S1): checks a
// recording of device traffic (FOUNDRY_WIRE_RECORD_DIR on the server) against
// the shapes each side declares today and summarises it per message type.
//
//   - Go: every recorded payload against the type its receiver decodes it
//     into, or the server encodes it from (apps/server/internal/httpapi
//     wire_drift_test.go, run here as `go test -run TestWireDriftReport`).
//   - TypeScript: what the server sends against the type the worker's
//     handler casts the payload to, and device REST answers against the
//     worker's getJSON/postJSON type (scripts/wire-drift/ts-shapes.mjs).
//
// Issues: unknown (a field the type does not declare: strict decoding would
// refuse it), missing (a field the type requires), type (another JSON type
// or a value the type cannot take), null (null where the type has none).
// Coverage counts the types and routes declared in wire_drift_test.go,
// which TestWireDeclsCoverTheDeviceProtocol holds to every ws*Type constant
// and recorded route.
//
// Usage: node scripts/wire-drift-report.mjs <recording dir or wire.jsonl>
//          [--json <out.json>] [--details <n issues per kind, default 5>]
//          [--go-report <json from TestWireDriftReport>]
// Run it under the heavy-check lock on a shared machine: it compiles the
// server's tests and type-checks the worker.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/** Records of a recording; a torn last line is left out. */
export function readRecording(path) {
  const records = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      break;
    }
  }
  return records;
}

export function runGoReport(recording) {
  const out = join(mkdtempSync(join(tmpdir(), "wire-drift-")), "go.json");
  const result = spawnSync(
    "go",
    ["test", "./internal/httpapi", "-run", "^TestWireDriftReport$", "-count=1"],
    {
      cwd: resolve(root, "apps/server"),
      env: {
        ...process.env,
        FOUNDRY_WIRE_DRIFT_INPUT: recording,
        FOUNDRY_WIRE_DRIFT_OUTPUT: out,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  if (result.status !== 0)
    throw new Error(`go test failed:\n${result.stdout ?? ""}`);
  return JSON.parse(readFileSync(out, "utf8"));
}

const key = (channel, dir, kind) => `${channel} ${dir ?? ""} ${kind}`;
const routeKey = (pattern) => pattern.replace(/\{[^}]*\}/g, "{}");

function countIssues(map, issues) {
  const seen = new Set();
  for (const issue of issues) {
    const id = JSON.stringify([issue.kind, issue.path, issue.detail ?? ""]);
    if (seen.has(id)) continue;
    seen.add(id);
    map.set(id, (map.get(id) ?? 0) + 1);
  }
}

function sortedIssues(map) {
  return [...map]
    .map(([id, samples]) => {
      const [kind, path, detail] = JSON.parse(id);
      return detail ? { kind, path, detail, samples } : { kind, path, samples };
    })
    .sort(
      (a, b) =>
        b.samples - a.samples ||
        a.kind.localeCompare(b.kind) ||
        a.path.localeCompare(b.path),
    );
}

/**
 * The TypeScript check of each record, by kind.
 * @param {ReturnType<import("./wire-drift/ts-shapes.mjs").loadWorkerShapes>} shapes
 * @param {typeof import("./wire-drift/ts-shapes.mjs").checkTs} checkTs
 */
export function tsKinds(records, shapes, checkTs) {
  const kinds = new Map();
  for (const record of records) {
    const k = key(record.channel, record.dir, record.kind);
    let kind = kinds.get(k);
    if (!kind) {
      kind = { declared: "", unchecked: "", issues: new Map() };
      kinds.set(k, kind);
    }
    let declared;
    let value;
    let path = "payload";
    if (record.channel === "ws" && record.dir === "out") {
      declared = shapes.messages.get(record.kind);
      if (!declared)
        kind.unchecked = shapes.untyped.has(record.kind)
          ? `handler reads the payload untyped (${shapes.untyped.get(record.kind)})`
          : "no worker handler for this type";
      value = record.payload;
    } else if (record.channel === "ws") {
      kind.unchecked = "the worker sends object literals (payload: unknown)";
    } else {
      const [method, pattern] = record.kind.split(" ");
      declared = shapes.rest.get(`${method} ${routeKey(pattern)}`);
      if (!declared)
        kind.unchecked = "no getJSON/postJSON/api type for this route";
      value = record.response;
      path = "response";
      if (record.status >= 300 || value === undefined) declared = undefined;
    }
    if (!declared) continue;
    kind.declared = `${declared.text} (${declared.where})`;
    kind.unchecked = "";
    if (value === undefined) {
      if (declared.optional) continue;
      countIssues(kind.issues, [
        { kind: "missing", path, detail: declared.text },
      ]);
      continue;
    }
    countIssues(
      kind.issues,
      checkTs(shapes.checker, declared.type, value, path),
    );
  }
  return kinds;
}

/** Merges the Go report and the TypeScript check into one per kind. */
export function buildReport({ goReport, records, ts }) {
  const kinds = new Map();
  for (const declared of goReport.declared)
    kinds.set(key(declared.channel, declared.dir, declared.kind), {
      channel: declared.channel,
      dir: declared.dir ?? "",
      kind: declared.kind,
      declared: true,
      samples: 0,
      go: {
        declared: declared.goType ?? "",
        unchecked: declared.unchecked ?? "",
        issues: [],
      },
    });
  for (const recorded of goReport.kinds ?? []) {
    const k = key(recorded.channel, recorded.dir, recorded.kind);
    const kind = kinds.get(k) ?? {
      channel: recorded.channel,
      dir: recorded.dir ?? "",
      kind: recorded.kind,
      declared: false,
    };
    Object.assign(kind, {
      samples: recorded.samples,
      shapes: recorded.shapes,
      omitted: recorded.omitted ?? 0,
      errors: recorded.errors ?? 0,
      statuses: recorded.statuses,
      go: {
        declared: recorded.declared ?? "",
        unchecked: recorded.unchecked ?? "",
        issues: recorded.issues ?? [],
      },
    });
    kinds.set(k, kind);
  }
  for (const [k, checked] of ts) {
    const kind = kinds.get(k);
    if (!kind) continue;
    kind.ts = {
      declared: checked.declared,
      unchecked: checked.unchecked,
      issues: sortedIssues(checked.issues),
    };
  }
  const list = [...kinds.values()].sort(
    (a, b) =>
      a.channel.localeCompare(b.channel) ||
      a.dir.localeCompare(b.dir) ||
      a.kind.localeCompare(b.kind),
  );
  const coverage = {};
  for (const kind of list.filter((k) => k.declared)) {
    const group = `${kind.channel}${kind.dir ? " " + kind.dir : ""}`;
    coverage[group] ??= { declared: 0, recorded: 0, missing: [] };
    coverage[group].declared++;
    if (kind.samples > 0) coverage[group].recorded++;
    else coverage[group].missing.push(kind.kind);
  }
  const times = records
    .map((r) => r.at)
    .filter(Boolean)
    .sort();
  return {
    records: records.length,
    from: times[0],
    to: times.at(-1),
    coverage,
    undeclared: list
      .filter((k) => !k.declared)
      .map((k) => key(k.channel, k.dir, k.kind)),
    kinds: list,
  };
}

const tally = (issues) => {
  const counts = { unknown: 0, missing: 0, type: 0, null: 0 };
  for (const issue of issues ?? [])
    counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
  return counts;
};

const cell = (side) => {
  if (!side) return "-";
  if (!side.declared && side.unchecked) return "unchecked";
  const t = tally(side.issues);
  return `${t.unknown}/${t.missing}/${t.type}/${t.null}`;
};

export function formatReport(report, { details = 5, source = "" } = {}) {
  const lines = [];
  lines.push(`Wire drift report ${source}`.trim());
  lines.push(
    `${report.records} records${report.from ? `, ${report.from} to ${report.to}` : ""}`,
  );
  lines.push(
    "Coverage of the declared types and routes (wire_drift_test.go, held to every ws*Type constant and recorded route):",
  );
  for (const [group, c] of Object.entries(report.coverage))
    lines.push(`  ${group.padEnd(7)} ${c.recorded}/${c.declared} recorded`);
  for (const [group, c] of Object.entries(report.coverage))
    if (c.missing.length)
      lines.push(`  not recorded (${group}): ${c.missing.join(", ")}`);
  if (report.undeclared.length)
    lines.push(`  recorded but not declared: ${report.undeclared.join(", ")}`);
  lines.push("");
  lines.push(
    "Issues per kind as unknown/missing/type/null samples-with-issue counts; `unchecked`: no declared type on that side.",
  );
  const recorded = report.kinds.filter((k) => k.samples > 0);
  const width = Math.max(28, ...recorded.map((k) => k.kind.length + 1));
  lines.push(
    `${"chan dir".padEnd(9)} ${"kind".padEnd(width)} ${"samples".padStart(7)} ${"shapes".padStart(6)}  ${"go".padEnd(12)} ts`,
  );
  for (const k of recorded)
    lines.push(
      `${`${k.channel} ${k.dir}`.padEnd(9)} ${k.kind.padEnd(width)} ${String(k.samples).padStart(7)} ${String(k.shapes ?? 0).padStart(6)}  ${cell(k.go).padEnd(12)} ${cell(k.ts)}`,
    );
  const goIssues = recorded.reduce(
    (n, k) => n + (k.go?.issues?.length ?? 0),
    0,
  );
  const tsIssues = recorded.reduce(
    (n, k) => n + (k.ts?.issues?.length ?? 0),
    0,
  );
  lines.push("");
  lines.push(
    `Distinct issues: Go ${goIssues}, TypeScript ${tsIssues}, over ${recorded.length} recorded kinds.`,
  );
  if (details > 0) {
    for (const k of recorded) {
      const sides = [
        ["go", k.go],
        ["ts", k.ts],
      ].filter(([, side]) => side?.issues?.length);
      if (!sides.length) continue;
      lines.push(`${k.channel} ${k.dir} ${k.kind}`.replace(/  +/g, " "));
      for (const [name, side] of sides) {
        lines.push(`  ${name}: ${side.declared}`);
        for (const issue of side.issues.slice(0, details))
          lines.push(
            `    ${issue.kind} ${issue.path}${issue.detail ? ` (${issue.detail})` : ""}: ${issue.samples}/${k.samples}`,
          );
        if (side.issues.length > details)
          lines.push(`    … ${side.issues.length - details} more (--json)`);
      }
    }
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = { details: 5 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.json = argv[++i];
    else if (arg === "--details") args.details = Number(argv[++i]);
    else if (arg === "--go-report") args.goReport = argv[++i];
    else if (arg === "-h" || arg === "--help") args.help = true;
    else args.recording = arg;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.recording) {
    console.log(
      "usage: node scripts/wire-drift-report.mjs <recording dir or wire.jsonl> [--json out.json] [--details n] [--go-report go.json]",
    );
    process.exit(args.help ? 0 : 2);
  }
  let recording = resolve(args.recording);
  if (statSync(recording).isDirectory())
    recording = join(recording, "wire.jsonl");
  const records = readRecording(recording);
  const goReport = args.goReport
    ? JSON.parse(readFileSync(args.goReport, "utf8"))
    : runGoReport(recording);
  const { loadWorkerShapes, checkTs } =
    await import("./wire-drift/ts-shapes.mjs");
  const shapes = loadWorkerShapes();
  const report = buildReport({
    goReport,
    records,
    ts: tsKinds(records, shapes, checkTs),
  });
  report.worker = {
    typedMessages: shapes.messages.size,
    untypedMessages: [...shapes.untyped.keys()].sort(),
    typedRoutes: [...shapes.rest.keys()].sort(),
  };
  if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 1));
  console.log(
    formatReport(report, { details: args.details, source: recording }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
