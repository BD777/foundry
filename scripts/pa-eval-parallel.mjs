#!/usr/bin/env node
// Runs the Personal Agent eval (scripts/pa-eval-run.mjs) on N stacks at once
// and merges them into one report. Each shard is a complete, isolated eval:
// its own stack folder (pa-eval-stack.sh: fresh database, synthetic user,
// fixture), server port, fixture computers, assistant, sandboxes and model
// connection relay; it runs a contiguous slice of the (repetition, case)
// units in history-cutoff order, so most shards move their history once or
// not at all. First, one stack per cutoff summarizes the fixture's projects
// at that cutoff (pa-eval-run.mjs --prepare-digests); the shards start from
// those digests (--digest-cache) instead of each summarizing them again.
// Shared between stacks: the read-only eval set, the server binary, the
// installed Worker, the prepared digests and a limit on open model
// connections (--helper-slots); nothing else.
//
// usage: node scripts/pa-eval-parallel.mjs --server BIN --out FILE
//          [--parallel N] [--root DIR] [--eval DIR] [--repeat R] [--only id,id]
//          [--kind environment] [--default-model haiku] [--keep]
//          [--helper-slots N] [--digest-cache DIR]
//          [-- <pa-eval-run.mjs arguments: --profile, --max-cost-usd, ...>]
//
//   --parallel N   shards (default: from this computer's CPUs and memory:
//                  one per 4 CPUs and per 3 GB available, at most 24, at
//                  least one per 8 units)
//   --root DIR     where the stacks go (default /tmp/pa-eval-par-<time>;
//                  never under the home folder); removed at the end unless
//                  --keep
//   --helper-slots N  model connections open at once over all shards
//                  (default 20: a gateway client serves about 30, and the
//                  person's own sessions on the computer use it too)
//   --digest-cache DIR  where the fixture's digests per cutoff are kept
//                  (default ~/.foundry/pa-eval/digest-cache/<hash of the
//                  server binary, the set's index and the model>): a cutoff
//                  already there is not summarized again
//   --max-cost-usd after -- is the whole run's: each shard gets its share.
//   The server's execution default is KIND,PROFILE,claude,MODEL,high with
//   PROFILE from --profile (pa-eval-stack.sh).
// Shard reports, journals and logs are in <out>.shards/; the merged report
// is <out> (pa-eval-run.mjs --merge). Exit as pa-eval-run.mjs: 0 every gate
// passed, 1 a gate failed, 2 the run failed.

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { cutoffGroups } from "./pa-eval-fixture.mjs";

const here = import.meta.dirname;
const log = (...parts) => console.error("pa-eval-parallel:", ...parts);

function parseArgs(argv) {
  const args = {
    parallel: 0,
    root: "",
    eval: resolve(homedir(), ".foundry/pa-eval/set"),
    repeat: 1,
    only: [],
    server: "",
    out: "",
    kind: "environment",
    defaultModel: "haiku",
    keep: false,
    helperSlots: 20,
    digestCache: "",
    pass: [],
  };
  const dash = argv.indexOf("--");
  const own = dash < 0 ? argv.slice(2) : argv.slice(2, dash);
  args.pass = dash < 0 ? [] : argv.slice(dash + 1);
  for (let i = 0; i < own.length; i++) {
    const value = () => {
      const v = own[++i];
      if (v === undefined) throw new Error(`${own[i - 1]} needs a value`);
      return v;
    };
    switch (own[i]) {
      case "--parallel":
        args.parallel = Number(value());
        break;
      case "--root":
        args.root = resolve(value());
        break;
      case "--eval":
        args.eval = resolve(value());
        break;
      case "--repeat":
        args.repeat = Number(value());
        break;
      case "--only":
        args.only = value().split(",").filter(Boolean);
        break;
      case "--server":
        args.server = resolve(value());
        break;
      case "--out":
        args.out = resolve(value());
        break;
      case "--kind":
        args.kind = value();
        break;
      case "--default-model":
        args.defaultModel = value();
        break;
      case "--keep":
        args.keep = true;
        break;
      case "--helper-slots":
        args.helperSlots = Number(value());
        break;
      case "--digest-cache":
        args.digestCache = resolve(value());
        break;
      default:
        throw new Error(
          `unknown argument ${own[i]} (run arguments go after --)`,
        );
    }
  }
  if (!args.server || !args.out)
    throw new Error("--server and --out are required");
  if (!Number.isInteger(args.repeat) || args.repeat < 1)
    throw new Error("--repeat needs a whole number of at least 1");
  args.root ||= resolve("/tmp", `pa-eval-par-${Date.now()}`);
  if ((args.root + "/").startsWith(homedir() + "/"))
    throw new Error(`--root ${args.root} is under the home folder`);
  return args;
}

const passValue = (pass, flag) => {
  const i = pass.indexOf(flag);
  return i < 0 ? undefined : pass[i + 1];
};
const withoutFlag = (pass, flag) => {
  const i = pass.indexOf(flag);
  return i < 0 ? pass : [...pass.slice(0, i), ...pass.slice(i + 2)];
};

// Memory the computer can give, in GB (MemAvailable).
function availableGb() {
  const info = readFileSync("/proc/meminfo", "utf8");
  return Number(/MemAvailable:\s+(\d+)/.exec(info)?.[1] || 0) / 1024 / 1024;
}

/** Shards this computer can carry: a stack is ~2.5 GB and a few busy CPUs. */
export function defaultParallel(
  units,
  cpus = availableParallelism(),
  memGb = availableGb(),
) {
  const byCpu = Math.floor(cpus / 4);
  const byMemory = Math.floor((memGb - 2) / 3);
  const byWork = Math.ceil(units / 8);
  return Math.max(1, Math.min(24, byCpu, byMemory, byWork));
}

/**
 * The (repetition, case) units in history-cutoff order (oldest cutoff, then
 * repetition, then case), cut into `n` contiguous slices of near-equal size:
 * a slice spans few cutoffs, so its stack moves history rarely.
 */
export function planShards(cases, repeat, n) {
  const units = [];
  for (const group of cutoffGroups(cases))
    for (let k = 1; k <= repeat; k++)
      for (const c of group.cases)
        units.push({ id: c.id, repeat: k, cutoff: group.cutoff });
  const shards = [];
  for (let i = 0; i < n; i++) {
    const from = Math.round((i * units.length) / n);
    const to = Math.round(((i + 1) * units.length) / n);
    if (to > from) shards.push(units.slice(from, to));
  }
  return shards;
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: "utf8", ...options });
  if (result.status !== 0)
    throw new Error(
      `${command} ${argv.join(" ")}: ${result.status} ${result.stderr || result.stdout}`.slice(
        0,
        800,
      ),
    );
  return result.stdout;
}

async function main() {
  const { removeSkillSnapshotTree } =
    await import("../packages/worker/dist/skills/skill-snapshot-permissions.js");
  const args = parseArgs(process.argv);
  const all = readFileSync(resolve(args.eval, "cases.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const cases = args.only.length
    ? all.filter((c) => args.only.includes(c.id))
    : all;
  const missing = args.only.filter((id) => !cases.some((c) => c.id === id));
  if (missing.length)
    throw new Error(`unknown case ids: ${missing.join(", ")}`);
  const units = cases.length * args.repeat;
  const n = args.parallel || defaultParallel(units);
  const shards = planShards(cases, args.repeat, n);
  const [profile = "limen_default", model = "opus", effort = "high"] = (
    passValue(args.pass, "--profile") || "limen_default,opus,high"
  ).split(",");
  const totalCap = Number(passValue(args.pass, "--max-cost-usd") || 0);
  const pass = withoutFlag(args.pass, "--max-cost-usd");
  const outDir = `${args.out}.shards`;
  // Digests depend on the set, the server and the model: kept per that
  // combination, a later run with the same three reuses them.
  const digestCache =
    args.digestCache ||
    resolve(
      homedir(),
      ".foundry/pa-eval/digest-cache",
      createHash("sha256")
        .update(readFileSync(args.server))
        .update(readFileSync(resolve(args.eval, "index.json")))
        .update(`${profile},${model},${effort},${args.defaultModel}`)
        .digest("hex")
        .slice(0, 16),
    );
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  mkdirSync(args.root, { recursive: true, mode: 0o700 });
  const cutoffs = [...new Set(shards.flat().map((u) => u.cutoff))].sort();
  log(
    `${units} units on ${shards.length} shards (${shards.map((s) => s.length).join(" ")}); ${cutoffs.length} history cutoffs; stacks under ${args.root}`,
  );
  const started = Date.now();
  const children = [];
  // One stack, then the eval in it (pa-eval-run.mjs); its output in outDir.
  const launch = (name, runArgv) => {
    const stack = resolve(args.root, name);
    removeSkillSnapshotTree(stack);
    // Each stack: its own database, key, synthetic user and fixture.
    run(
      "bash",
      [
        resolve(here, "pa-eval-stack.sh"),
        stack,
        args.server,
        profile,
        args.defaultModel,
        effort,
        args.kind,
      ],
      { env: { ...process.env, PA_EVAL_SET: args.eval } },
    );
    const out = resolve(outDir, `${name}.json`);
    const argv = [
      resolve(here, "pa-eval-run.mjs"),
      "--stack-dir",
      stack,
      "--instance",
      `par-${name}`,
      "--eval",
      args.eval,
      "--out",
      out,
      "--digest-cache",
      digestCache,
      ...runArgv,
      ...(passValue(pass, "--profile")
        ? []
        : ["--profile", `${profile},${model},${effort}`]),
      ...pass,
    ];
    const logFile = resolve(outDir, `${name}.log`);
    const fd = openSync(logFile, "a");
    const child = spawn(process.execPath, argv, {
      stdio: ["ignore", fd, fd],
      // The model connection's helpers of all stacks share this computer's
      // gateway client: at most --helper-slots open at once.
      env: {
        ...process.env,
        PA_EVAL_HELPER_SLOTS_DIR: resolve(args.root, "helper-slots"),
        PA_EVAL_HELPER_SLOTS: String(args.helperSlots),
      },
    });
    closeSync(fd);
    const entry = {
      name,
      out,
      logFile,
      journal: `${out}.rows.jsonl`,
      child,
      done: new Promise((ok) => child.on("close", (code) => ok(code))),
    };
    children.push(entry);
    return entry;
  };
  const stop = () => {
    for (const c of children) c.child.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const tail = (c) =>
    readFileSync(c.logFile, "utf8").trim().split("\n").slice(-3).join(" | ");

  // 1. The fixture's digests at each cutoff, summarized once (one stack per
  // cutoff, in parallel), instead of once in every shard.
  const toPrepare = cutoffs.filter(
    (cutoff) => !existsSync(resolve(digestCache, `${cutoff}.json`)),
  );
  log(
    `digests: ${cutoffs.length - toPrepare.length} of ${cutoffs.length} cutoffs reused from ${digestCache}`,
  );
  const prepared = toPrepare.map((cutoff, i) =>
    launch(`d${String(i + 1).padStart(2, "0")}`, ["--prepare-digests", cutoff]),
  );
  const prepCodes = await Promise.all(prepared.map((c) => c.done));
  for (const [i, c] of prepared.entries())
    if (prepCodes[i] !== 0)
      log(
        `digests at ${toPrepare[i]} not prepared (the shards summarize them): ${tail(c)}`,
      );
  const preparedMs = Date.now() - started;
  log(`digests prepared in ${(preparedMs / 60000).toFixed(1)} min`);

  // 2. The shards.
  const running = shards.map((shardUnits, i) => {
    const name = `s${String(i + 1).padStart(2, "0")}`;
    const unitsFile = resolve(outDir, `${name}.units.json`);
    writeFileSync(unitsFile, JSON.stringify(shardUnits));
    const journal = resolve(outDir, `${name}.json.rows.jsonl`);
    const entry = launch(name, [
      "--e2e",
      "--units",
      unitsFile,
      ...(existsSync(journal) ? ["--resume", journal] : []),
      ...(totalCap
        ? ["--max-cost-usd", String((totalCap * shardUnits.length) / units)]
        : []),
    ]);
    entry.units = shardUnits.length;
    return entry;
  });
  const progress = setInterval(() => {
    const rows = running.map((c) =>
      existsSync(c.journal)
        ? readFileSync(c.journal, "utf8").split("\n").filter(Boolean).length
        : 0,
    );
    const total = rows.reduce((a, b) => a + b, 0);
    log(
      `${total}/${units} units after ${Math.round((Date.now() - started) / 60000)} min (${running.map((c, i) => `${c.name}:${rows[i]}/${c.units}`).join(" ")})`,
    );
  }, 60_000);
  const codes = await Promise.all(running.map((c) => c.done));
  clearInterval(progress);
  const wallMs = Date.now() - started;
  const failed = running.filter((c, i) => codes[i] === 2 || !existsSync(c.out));
  for (const c of failed) log(`shard ${c.name} failed: ${tail(c)}`);
  const reports = running.filter((c) => existsSync(c.out)).map((c) => c.out);
  if (!reports.length) {
    log("no shard finished");
    process.exit(2);
  }
  const merged = spawnSync(
    process.execPath,
    [
      resolve(here, "pa-eval-run.mjs"),
      "--merge",
      args.out,
      ...reports,
      "--eval",
      args.eval,
    ],
    { stdio: "inherit" },
  );
  const report = JSON.parse(readFileSync(args.out, "utf8"));
  const prepReports = prepared
    .filter((c) => existsSync(c.out))
    .map((c) => JSON.parse(readFileSync(c.out, "utf8")).prepared)
    .filter(Boolean);
  report.parallel = {
    ...report.parallel,
    wallMs,
    preparedMs,
    prepared: prepReports,
    shardsFailed: failed.map((c) => c.name),
    units,
  };
  writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  log(
    `${units} units on ${shards.length} shards in ${(wallMs / 60000).toFixed(1)} min (digests ${(preparedMs / 60000).toFixed(1)} min)${failed.length ? `; ${failed.length} shard(s) failed` : ""}`,
  );
  if (!args.keep) removeSkillSnapshotTree(args.root);
  process.exit(failed.length ? 2 : (merged.status ?? 2));
}

if (process.argv[1] === import.meta.filename)
  main().catch((error) => {
    console.error(`pa-eval-parallel: ${error.message}`);
    process.exit(2);
  });
