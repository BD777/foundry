#!/usr/bin/env node
// Durable, OS-enforced launcher for the worker test suite (macOS and Linux).
//
// Mechanical isolation, not an after-write assertion:
//   * FOUNDRY_STATE_ROOT is exported to the Node child BEFORE it (and any
//     dist module) is imported, so module-load-time path constants resolve
//     into per-run scratch regardless of static/dynamic import ordering.
//   * The OS sandbox enforces a WRITE ALLOWLIST: every write is denied
//     except per-run scratch and /dev. macOS uses sandbox-exec (explicit
//     denies for the real state roots and native credential homes are a
//     last-match backstop against symlink escapes); Linux uses bubblewrap,
//     which mounts / read-only and binds only scratch writable. Denials
//     happen in the kernel (EPERM/EROFS), so a wrong test cannot
//     overwrite/delete real state at all.
//   * HOME / CODEX_HOME / CLAUDE_CONFIG_DIR are never repointed; instead the
//     write allowlist protects them in place.
//
// Usage:
//   node scripts/run-worker-tests.mjs [--probe] [-- <forwarded node args>]
//   --probe   run only the disposable synthetic denial checks, no tests.
//
// Without a working backend (sandbox-exec on macOS, bwrap on Linux) this
// fails closed (exit 2) and never falls back to running the suite
// unprotected.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants,
  accessSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const BWRAP = "bwrap";
const here = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(here, "..");
const distEntry = join(workerRoot, "dist", "state-root.js");

const args = process.argv.slice(2);
const probeOnly = args.includes("--probe");
const passthrough = args.includes("--")
  ? args.slice(args.indexOf("--") + 1)
  : [];

function fail(message) {
  console.error(`\n[worker-test-launcher] ${message}`);
  console.error(
    "[worker-test-launcher] tests were NOT executed. Needs sandbox-exec " +
      "(macOS) or a working bwrap (Linux: apt install bubblewrap).\n" +
      "[worker-test-launcher] Deliberately unprotected (NOT recommended, " +
      "real state is at risk):\n" +
      "    node --test test/*.test.mjs\n",
  );
  process.exit(2);
}

// The kernel-level sandbox is macOS-only, so a Linux CI runner cannot have it.
// Refusing there would mean the suite never runs in CI at all, which trades a
// real regression signal for protection CI does not need: its filesystem is
// disposable and holds none of the developer state this launcher exists to
// guard. FOUNDRY_WORKER_TESTS_NO_SANDBOX says "this filesystem is expendable".
//
// It is not a way to skip isolation. The app-level isolation in
// childEnvironment() -- the scratch FOUNDRY_STATE_ROOT that fixes
// module-load-time path constants, the redirected TMPDIR, and the stripped
// credential and live-inference variables -- applies identically with or
// without the sandbox. What the opt-out drops is only the kernel backstop
// against an escape from those, so it is honoured solely where the sandbox is
// genuinely unavailable: on macOS the sandbox is present and stays mandatory,
// which keeps a developer from silencing it on the machine that holds the real
// ~/.foundry this launcher was written to protect.
// Linux needs unprivileged user namespaces for bwrap; some hosts (e.g.
// AppArmor-restricted Ubuntu runners) forbid them, so probe once instead of
// trusting that the binary exists.
function bwrapWorks() {
  if (platform() !== "linux") return false;
  const result = spawnSync(
    BWRAP,
    ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"],
    { stdio: "ignore" },
  );
  return result.status === 0;
}

const sandboxBackend =
  platform() === "darwin" && existsSync(SANDBOX_EXEC)
    ? "seatbelt"
    : bwrapWorks()
      ? "bwrap"
      : null;
const sandboxAvailable = sandboxBackend !== null;
const sandboxWaived =
  !sandboxAvailable && process.env.FOUNDRY_WORKER_TESTS_NO_SANDBOX === "1";

if (!sandboxAvailable && !sandboxWaived) {
  fail("OS-level write isolation is unavailable on this platform.");
}

if (sandboxWaived) {
  console.warn(
    "\n[worker-test-launcher] WARNING: no kernel sandbox on this platform; " +
      "running with app-level isolation only.\n" +
      "[worker-test-launcher] Scratch state root, redirected TMPDIR and " +
      "credential stripping still apply; the OS-level backstop does not.\n" +
      "[worker-test-launcher] Intended for disposable CI filesystems " +
      "(FOUNDRY_WORKER_TESTS_NO_SANDBOX=1). Never set this on a developer " +
      "machine holding real ~/.foundry state.\n",
  );
}

/** Resolve symlink aliases (/var -> /private/var) even for missing paths. */
function canonical(p) {
  const absolute = resolve(p);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return join(
        realpathSync.native(dirname(absolute)),
        absolute.slice(dirname(absolute).length + 1),
      );
    } catch {
      return absolute;
    }
  }
}

const q = (p) => JSON.stringify(p);

function protectedTargets() {
  const home = homedir();
  const targets = [
    join(home, ".foundry"),
    join(home, ".foundry-stacks"),
    join(home, ".config", "foundry"),
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".codex-personal"),
    join(home, ".codex-gw-cli"),
  ];
  // Native homes may be redirected via their own env vars; protect the real
  // configured location without repointing or exposing it.
  for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    if (process.env[key]) targets.push(process.env[key]);
  }
  return [...new Set(targets.map(canonical))].sort();
}

function buildProfile(scratchRoot, extraDenies = []) {
  const denies = [...protectedTargets(), ...extraDenies.map(canonical)];
  const lines = [
    "(version 1)",
    ";; Default-allow for reads/network/process; writes are then locked down.",
    "(allow default)",
    ";; Write allowlist: only per-run scratch and /dev/null may be written.",
    "(deny file-write*)",
    `(allow file-write* (literal "/dev/null") (subpath ${q(canonical(scratchRoot))}))`,
    ";; Last-match backstop for real state/credential homes (symlink escape).",
    `(deny file-write* ${denies.map((p) => `(subpath ${q(p)})`).join(" ")})`,
    "",
  ];
  return lines.join("\n");
}

function childEnvironment(scratchTmp, scratchState) {
  const env = { ...process.env };
  // Fixed before Node starts: module-load-time path constants land in scratch.
  env.FOUNDRY_STATE_ROOT = scratchState;
  // Everything that honors TMPDIR (incl. spawned children) lands in scratch.
  env.TMPDIR = scratchTmp;
  env.TMP = scratchTmp;
  env.TEMP = scratchTmp;
  // Never hand control/credential material to test processes.
  for (const key of Object.keys(env)) {
    if (
      /^FOUNDRY_.*(?:TOKEN|PAIRING|CONTROL|SECRET)/i.test(key) ||
      key === "ANTHROPIC_API_KEY" ||
      key === "OPENAI_API_KEY"
    ) {
      delete env[key];
    }
  }
  // Explicitly strip live-inference opt-in: a normal `pnpm test` must never
  // make a real model call just because the caller's shell exported it.
  // Live verification stays a separate, deliberately-set entry point.
  delete env.FOUNDRY_VERIFY_LIVE;
  delete env.FOUNDRY_VERIFY_HARNESS;
  // Mode A runs evidence-api-e2e without the outer seatbelt; its live-agent
  // branch is gated on this var, so it must be stripped exactly like the
  // others — a normal suite run never makes a real model call.
  delete env.FOUNDRY_VERIFY_E2E_LIVE;
  return env;
}

/**
 * The argv that runs `argv` under the platform's write allowlist: only
 * `scratchRoot` (and /dev) writable. `extraDenies` names additional paths the
 * caller expects to be unwritable; on bwrap everything outside scratch is
 * already read-only, so they only matter for the seatbelt profile.
 */
function sandboxedCommand(scratchRoot, argv, extraDenies = []) {
  if (sandboxBackend === "bwrap") {
    const scratch = canonical(scratchRoot);
    return [
      BWRAP,
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--tmpfs",
      "/dev/shm",
      "--proc",
      "/proc",
      "--bind",
      scratch,
      scratch,
      "--die-with-parent",
      ...argv,
    ];
  }
  const profilePath = join(
    scratchRoot,
    `profile-${extraDenies.length ? "twin" : "production"}.sb`,
  );
  writeFileSync(profilePath, buildProfile(scratchRoot, extraDenies), {
    mode: 0o600,
  });
  return [SANDBOX_EXEC, "-f", profilePath, ...argv];
}

function runSandboxed(scratchRoot, argv, env) {
  // When the sandbox is waived (disposable CI filesystem, no sandbox-exec to
  // call), run the same argv directly. This is deliberately the ONLY seam that
  // honours the waiver: env comes from childEnvironment() either way, so the
  // scratch state root, redirected TMPDIR and credential stripping are
  // identical -- only the kernel backstop is absent. Mode A already runs this
  // way on every platform, so a waived Mode B is the same shape as Mode A.
  if (sandboxWaived) {
    const [command, ...rest] = argv;
    return spawnSync(command, rest, { stdio: "inherit", env });
  }
  const [command, ...rest] = sandboxedCommand(scratchRoot, argv);
  return spawnSync(command, rest, { stdio: "inherit", env });
}

function makeScratch() {
  // Per-run roots must live under a SHORT prefix: issue-executor binds a unix
  // domain socket at $TMPDIR/foundry-<uuid>.sock, and macOS caps sun_path at
  // 104 bytes. The inherited $TMPDIR is already ~56 chars, so nesting another
  // layer under it yields EINVAL on listen(). /private/tmp keeps the full
  // socket path at ~84 chars. mkdtemp creates the dir 0700; fail closed if
  // this base is unavailable rather than silently using a too-deep path.
  const shortBase = platform() === "darwin" ? "/private/tmp" : "/tmp";
  if (!existsSync(shortBase))
    fail(`${shortBase} is unavailable for per-run scratch.`);
  const root = mkdtempSync(join(shortBase, "fwt-"));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  return canonical(root);
}

/* ----------------------------- synthetic probe ---------------------------- */

function probe() {
  const scratch = makeScratch();
  const scratchTmp = join(scratch, "tmp");
  const scratchState = join(scratch, "state");
  // A disposable "pretend home", never a real state/credential directory.
  const protectedSynth = mkdtempSync(
    join(realpathSync.native(tmpdir()), "foundry-wtest-protected-"),
  );
  mkdirSync(join(protectedSynth, "sub"), { recursive: true });
  writeFileSync(join(protectedSynth, "existing.txt"), "keep");
  // A second disposable root outside scratch proves the allowlist itself.
  const outside = mkdtempSync(
    join(realpathSync.native(tmpdir()), "foundry-wtest-outside-"),
  );

  const run = (argv, options, extraDenies = []) => {
    const [command, ...rest] = sandboxedCommand(scratch, argv, extraDenies);
    return spawnSync(command, rest, options);
  };

  const workerPath = join(scratch, "probe-worker.mjs");
  writeFileSync(
    workerPath,
    `import { writeFileSync, mkdirSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [prot, allowed] = process.argv.slice(2);
const attempt = (name, fn) => {
  try { fn(); return { name, denied: false }; }
  catch (e) { return { name, denied: true, code: e.code }; }
};
const results = [];
results.push(attempt("protected create+write", () => writeFileSync(prot + "/new.txt", "x")));
results.push(attempt("protected overwrite", () => writeFileSync(prot + "/existing.txt", "x")));
results.push(attempt("protected mkdir", () => mkdirSync(prot + "/new-dir")));
results.push(attempt("protected rename", () => renameSync(prot + "/existing.txt", prot + "/renamed.txt")));
results.push(attempt("protected unlink", () => unlinkSync(prot + "/existing.txt")));
let childDenied = false, childCode = null;
try {
  execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'x')", prot + "/child.txt"], { stdio: "ignore" });
} catch (e) { childDenied = true; childCode = e.status; }
results.push({ name: "protected child-process write", denied: childDenied, code: "childExit" + childCode });
results.push(attempt("allowed write", () => writeFileSync(allowed + "/ok.txt", "x")));
results.push(attempt("allowed mkdir", () => mkdirSync(allowed + "/d")));
results.push(attempt("allowed rename", () => renameSync(allowed + "/ok.txt", allowed + "/ok2.txt")));
results.push(attempt("allowed unlink", () => unlinkSync(allowed + "/ok2.txt")));
results.push({ name: "protected preexisting file survived", denied: false, kept: existsSync(prot + "/existing.txt") });
console.log(JSON.stringify(results));
`,
  );

  const env = childEnvironment(scratchTmp, scratchState);
  const receipts = [];

  // 1) Production profile must parse/load and run a trivial process.
  const parseRun = run(["/usr/bin/true"], { env });
  receipts.push([
    `production sandbox loads (${sandboxBackend} /usr/bin/true)`,
    parseRun.status === 0,
    parseRun.status === 0
      ? "exit 0"
      : `exit ${parseRun.status}: ${String(parseRun.stderr)}`,
  ]);

  // 2) Twin profile: every protected op denied, every allowed op succeeds,
  //    and sandbox constraints are inherited by child processes.
  const twin = run(
    [process.execPath, workerPath, protectedSynth, scratchTmp],
    { env, encoding: "utf8" },
    [protectedSynth],
  );
  let checks = [];
  try {
    checks = JSON.parse(twin.stdout.trim().split("\n").pop());
  } catch {
    receipts.push([
      "twin synthetic ops",
      false,
      `could not parse worker output: ${twin.stdout} ${twin.stderr}`,
    ]);
  }
  const expectedDenied = [
    "protected create+write",
    "protected overwrite",
    "protected mkdir",
    "protected rename",
    "protected unlink",
    "protected child-process write",
  ];
  for (const name of expectedDenied) {
    const r = checks.find((c) => c.name === name);
    receipts.push([
      name,
      Boolean(r?.denied),
      r ? JSON.stringify(r) : "missing result",
    ]);
  }
  for (const name of [
    "allowed write",
    "allowed mkdir",
    "allowed rename",
    "allowed unlink",
  ]) {
    const r = checks.find((c) => c.name === name);
    receipts.push([
      name,
      r && !r.denied,
      r ? JSON.stringify(r) : "missing result",
    ]);
  }
  const kept = checks.find((c) => c.name.startsWith("protected preexisting"));
  receipts.push([
    "protected file content survives delete attempt",
    kept?.kept === true,
    kept ? JSON.stringify(kept) : "missing result",
  ]);

  // 3) Production profile's write allowlist denies an unrelated disposable
  //    root (mechanical allowlist proof that never names a real target).
  const allowlistProbe = join(scratch, "allowlist-probe.cjs");
  writeFileSync(
    allowlistProbe,
    `try { require('node:fs').writeFileSync(process.argv[2] + '/x.txt', 'x');
  console.log('OUTSIDE_WRITE_ALLOWED'); } catch (e) { console.log('OUTSIDE_WRITE_DENIED:' + e.code); }`,
  );
  const outsideRun = run([process.execPath, allowlistProbe, outside], {
    env,
    encoding: "utf8",
  });
  const outsideOut = String(outsideRun.stdout).trim();
  receipts.push([
    "allowlist denies write outside scratch (disposable dir)",
    outsideOut.startsWith("OUTSIDE_WRITE_DENIED"),
    outsideOut || `exit ${outsideRun.status}`,
  ]);
  const scratchProbe = join(scratch, "scratch-write-probe.cjs");
  writeFileSync(
    scratchProbe,
    `try { require('node:fs').writeFileSync(process.argv[2] + '/ok.txt', 'x');
  console.log('SCRATCH_WRITE_ALLOWED'); } catch (e) { console.log('SCRATCH_WRITE_DENIED:' + e.code); }`,
  );
  const insideRun = run([process.execPath, scratchProbe, scratchTmp], {
    env,
    encoding: "utf8",
  });
  receipts.push([
    "allowlist permits write inside per-run scratch",
    String(insideRun.stdout).trim() === "SCRATCH_WRITE_ALLOWED",
    String(insideRun.stdout).trim(),
  ]);

  // 4) Every real target is covered: named by canonical path in the
  //    seatbelt profile, or outside the only writable bind on bwrap.
  const profileText =
    sandboxBackend === "seatbelt"
      ? readText(join(scratch, "profile-production.sb"))
      : "";
  for (const target of protectedTargets()) {
    const covered =
      sandboxBackend === "seatbelt"
        ? profileText.includes(`(subpath ${q(target)})`)
        : target !== scratch && !target.startsWith(`${scratch}/`);
    receipts.push([
      `production sandbox covers ${target}`,
      covered,
      covered ? "present" : "MISSING",
    ]);
  }

  let failures = 0;
  console.log("\n[worker-test-launcher] synthetic isolation probe");
  for (const [name, ok, detail] of receipts) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
    if (!ok) failures++;
  }

  // Disposable proof dirs only; nothing under a real home was touched.
  rmSync(protectedSynth, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });

  if (failures) {
    console.error(
      `\n[worker-test-launcher] ${failures} isolation check(s) failed; refusing to run tests.\n`,
    );
    process.exit(1);
  }
  console.log(
    "\n[worker-test-launcher] all synthetic denials demonstrated; no real target was written.\n",
  );
}

function readText(p) {
  return readFileSync(p, "utf8");
}

/* ------------------------------- test runner ------------------------------- */

// Tests in this set apply the product's OWN inner sandbox-exec to executor
// stages. macOS seatbelt forbids re-applying a file-restricting profile inside
// an already file-restricted profile (sandbox_apply EPERM, verified), so these
// files cannot run under the outer write-allowlist profile. They still get a
// per-run temporary FOUNDRY_STATE_ROOT/TMPDIR and stripped credentials/live
// env; their executor writes remain protected by the product's inner sandbox
// (which these very tests assert), and every other path they touch is under
// mkdtemp(os.tmpdir()). Exact allowlist only — reviewed file by file. All
// other worker tests keep the outer OS write-allowlist seatbelt.
const NATIVE_SANDBOX_TESTS = new Set([
  "evidence-agent-sandbox.test.mjs",
  "evidence-api-e2e.test.mjs",
  "evidence-integration.test.mjs",
  "execution-process.test.mjs",
  "issue-environments.test.mjs",
  "issue-preview.test.mjs",
  "sandbox.test.mjs",
  "session-runtime.test.mjs",
]);

/**
 * node-pty ships its spawn-helper without the executable bit surviving the
 * package extraction, and the product code self-heals with a chmod on first
 * use. Inside the sandbox that chmod targets node_modules, which the write
 * allowlist denies, so a freshly cloned checkout fails a test that passes on
 * any machine where an earlier unsandboxed run already fixed the bit -- the
 * failure follows the checkout's age, not the code. Normalising it here, in
 * the launcher, which always runs unsandboxed, keeps the sandbox strict and
 * makes the first run on a new clone behave like every later one.
 */
function normalizePtySpawnHelper() {
  if (platform() === "win32") return;
  const helper = join(
    workerRoot,
    "node_modules",
    "node-pty",
    "prebuilds",
    `${platform()}-${process.arch}`,
    "spawn-helper",
  );
  if (!existsSync(helper)) return;
  try {
    accessSync(helper, constants.X_OK);
  } catch {
    try {
      chmodSync(helper, statSync(helper).mode | 0o111);
      console.warn(
        "[worker-test-launcher] restored the executable bit on node-pty's " +
          "spawn-helper (lost during package extraction).",
      );
    } catch (error) {
      console.warn(
        `[worker-test-launcher] could not chmod node-pty spawn-helper: ${error.message}`,
      );
    }
  }
}

function runTests() {
  if (!existsSync(distEntry)) {
    fail(
      "dist/ is missing; build first (pnpm build) so tests load compiled modules.",
    );
  }
  normalizePtySpawnHelper();
  const scratch = makeScratch();
  const scratchTmp = join(scratch, "tmp");
  const scratchState = join(scratch, "state");

  const allFiles =
    passthrough.length > 0
      ? passthrough.slice()
      : readdirSync(join(workerRoot, "test"))
          .filter((f) => f.endsWith(".test.mjs"))
          .sort();
  const nativeFiles = [];
  const protectedFiles = [];
  for (const file of allFiles) {
    const base = file.split("/").pop();
    if (NATIVE_SANDBOX_TESTS.has(base)) nativeFiles.push(file);
    else protectedFiles.push(file);
  }
  const resolveFile = (file) =>
    file.endsWith(".test.mjs") && !file.includes("/")
      ? join(workerRoot, "test", file)
      : file;

  console.error(
    `[worker-test-launcher] state=${scratchState} tmp=${scratchTmp}`,
  );
  console.error(
    `[worker-test-launcher] protected: ${protectedTargets().join(", ")}`,
  );

  // Mode B: outer OS write-allowlist seatbelt enforces real-state rejection.
  function runProtected(files) {
    if (!files.length) return { status: 0 };
    const args = ["--test", ...files.map(resolveFile)];
    return runSandboxed(
      scratch,
      [process.execPath, ...args],
      childEnvironment(scratchTmp, scratchState),
    );
  }

  let status = 0;
  // Mode A files get one node call without the outer seatbelt...
  if (nativeFiles.length) {
    const r = spawnSync(
      process.execPath,
      ["--test", ...nativeFiles.map(resolveFile)],
      { stdio: "inherit", env: childEnvironment(scratchTmp, scratchState) },
    );
    const s = typeof r.status === "number" ? r.status : 1;
    if (s !== 0) status = s;
  }
  // ...then Mode B files under the outer OS write allowlist.
  if (protectedFiles.length) {
    const r = runProtected(protectedFiles);
    const s = typeof r.status === "number" ? r.status : 1;
    if (s !== 0 && status === 0) status = s;
  }

  // Scratch is throwaway per run; leave it on failure for inspection.
  if (status === 0) rmSync(scratch, { recursive: true, force: true });
  else
    console.error(
      `[worker-test-launcher] tests failed; scratch kept at ${scratch}`,
    );
  process.exit(status);
}

if (probeOnly) {
  // --probe exists to demonstrate that the KERNEL denies writes to real
  // targets, so it is meaningless without a sandbox and must never report
  // success under the waiver -- a green probe that proved nothing would be a
  // false green, which is worse than a red because nobody investigates it.
  if (sandboxWaived) {
    fail("--probe demonstrates kernel-level denials and needs the sandbox.");
  }
  probe();
} else runTests();
