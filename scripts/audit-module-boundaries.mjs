#!/usr/bin/env node
// Module boundary guard for the layering in docs/architecture-modules.md §3.1.
//
// Worker (packages/worker/src):
//   1. Every source file belongs to exactly one module below; a new file must
//      be assigned before it can merge.
//   2. A module may import only the modules it depends on (transitively).
//      The composition root may import anything; nothing imports it.
//   3. Only harness modules import the Claude / Codex SDKs, and only the
//      Sandbox module spells `sandbox-exec` or `bwrap`.
//
// Server (apps/server/internal, non-test files):
//   4. Go packages import only the packages declared for them.
//   5. The monolithic `store.Store` interface does not grow; new storage goes
//      into module-scoped interfaces.
//
// Existing violations are tracked in module-boundaries-baseline.json and may
// only shrink. Run with FOUNDRY_AUDIT_UPDATE=1 after removing a violation to
// rewrite the baseline; the update refuses to record new violations.
//
// Usage: node scripts/audit-module-boundaries.mjs

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workerSource = resolve(root, "packages/worker/src");
const serverInternal = resolve(root, "apps/server/internal");
const baselinePath = resolve(
  import.meta.dirname,
  "module-boundaries-baseline.json",
);

/** Worker modules: direct dependencies and member files (paths without .ts). */
export const workerModules = {
  platform: {
    dependsOn: [],
    files: [
      "config",
      "paths",
      "secret-redaction",
      "process-group",
      "process-group-child",
      "agent-processes",
      "agent-process-host",
      "state-root",
      "stall-monitor",
      "connection-reports",
      "storage",
      "json-values",
      "utils",
      "task-scheduler",
    ],
  },
  device: {
    dependsOn: ["platform"],
    files: ["device", "device-pairing", "device-removal"],
  },
  sandbox: {
    dependsOn: ["platform"],
    files: [
      "sandbox/index",
      "sandbox/types",
      "sandbox/host",
      "sandbox/darwin",
      "sandbox/linux",
    ],
  },
  "candidate-store": {
    dependsOn: ["platform"],
    files: [
      "execution-storage",
      "execution-git",
      "execution-types",
      "issue-environment-changes",
    ],
  },
  transport: {
    dependsOn: ["device"],
    files: ["transport", "server-http"],
  },
  "workspace-registry": {
    dependsOn: ["candidate-store", "device"],
    files: [
      "workspaces",
      "workspace-attachments",
      "workspace-registration",
      "workspace-bootstrap",
      "workspace-inspection",
      "repository-registry",
    ],
  },
  "material-store": {
    dependsOn: ["candidate-store"],
    files: ["evidence-store", "evidence-uploads", "reference-files"],
  },
  "harness-profiles": {
    dependsOn: ["device"],
    files: [
      "profiles",
      "agent-profile-state",
      "native-account",
      "native-agent-config",
      "native-cli",
      "native-cli-install",
      "native-inspection",
      "native-login",
      "native-login-environment",
      "native-homes",
      "models",
      "official-skills",
      "provider-check-state",
      "provider-health",
    ],
  },
  skills: {
    dependsOn: ["transport", "harness-profiles"],
    files: [
      "skill-dependencies",
      "skill-files",
      "skill-isolation",
      "skill-materializer",
      "skill-requirements",
      "skill-scan-thread",
      "skill-scanner",
      "skill-zip",
      "managed-tools",
      "skill-repository-fetch",
    ],
  },
  resources: {
    dependsOn: ["platform"],
    files: [
      "resources/index",
      "resources/detector",
      "resources/exec",
      "resources/scanner",
      "resources/detectors/index",
      "resources/detectors/account",
      "resources/detectors/browser",
      "resources/detectors/computer-use-macos",
      "resources/detectors/container-runtime",
      "resources/detectors/developer-tools",
      "resources/detectors/disk",
      "resources/detectors/gpu",
      "resources/detectors/mobile-device",
      "resources/detectors/simulator",
      "resources/detectors/toolchain",
      "resources/detectors/computer-use-cua-driver",
      "resources/provider",
      "resources/providers/mcp-stdio",
      "resources/providers/cua-driver",
      "resources/cua-driver-host",
      "resources/operations",
      "resources/install",
      "resources/archive",
      "resources/compute-settings",
      "resources/detectors/compute",
      "resources/providers/compute",
    ],
  },
  "resource-pool": {
    dependsOn: ["platform", "resources"],
    files: ["resource-pool"],
  },
  "session-runtime": {
    dependsOn: [
      "resource-pool",
      "sandbox",
      "harness-profiles",
      "skills",
      "candidate-store",
      "transport",
    ],
    files: [
      "provider-check",
      "runner",
      "runner/active-runtimes",
      "runner/claude-launch",
      "runner/claude-messages",
      "runner/claude-options",
      "runner/claude-runtime-start",
      "runner/claude-turn",
      "runner/claude-turn-controls",
      "runner/codex-options",
      "runner/codex-stream",
      "runner/codex-thread",
      "runner/codex-turn",
      "runner/foundry-tools",
      "runner/profile-command",
      "runner/turn-directory",
      "sdk-messages",
      "session-ambient",
      "session-artifacts",
      "session-helpers",
      "session-files",
      "workspace-files",
      "session-file-diffs",
      "session-file-references",
      "session-policy",
      "session-prompt",
      "session-roles",
      "session-state",
      "session-control",
      "turn-usage",
      "context-usage",
      "agent-timers",
      "session-timers",
      "agent-background-tasks",
      "background-output-follow",
      "watchdog",
      "subagent-records",
      "subagent-transcript",
      "session-scratch-adoption",
      "native-chat",
      "native-chat-records",
      "native-chat-transcript",
      "native-session",
      "native-usage",
      "session-usage",
      "transcript-adapters/claude",
      "transcript-adapters/codex",
      "session/index",
      "session/types",
      "session/policy",
      "session/harness",
      "session/claude",
      "session/codex",
      "session/workspace",
      "session/host-child",
      "session/isolated-environment",
      "session/provider-credentials",
      "verification-session",
      "external-accounts",
      "feishu-gateway-forwarder",
    ],
  },
  "agent-surface": {
    dependsOn: ["session-runtime"],
    files: [
      "foundry-cli",
      "foundry-cli-commands",
      "foundry-client",
      "foundry-mcp",
    ],
  },
  issue: {
    dependsOn: [
      "session-runtime",
      "agent-surface",
      "material-store",
      "workspace-registry",
    ],
    files: [
      "issues",
      "issue-sessions",
      "issue-clarification",
      "issue-references",
      "issue-environment-rpc",
      "issue-environments",
      "issue-execution",
      "issue-execution-prompt",
      "issue-executor",
      "issue-preview",
      "issue-recovery",
      "issue-runtime-options",
      "issue-steering",
      "evidence-acceptance",
      "evidence-agent",
      "evidence-change-manifest",
      "evidence-collectors",
      "evidence-command-sandbox",
      "evidence-dependencies",
      "evidence-http-service",
      "evidence-redaction",
      "evidence-rpc",
      "evidence-snapshots",
      "execution-process",
      "execution-sandbox",
      "candidate-refresh",
      "workspace-acceptance",
      "repository-tool",
      "environment-status",
    ],
  },
  composition: {
    dependsOn: "*",
    files: [
      "cli",
      "cli-contract",
      "daemon-connection",
      "daemon/context",
      "daemon/control-connection",
      "daemon/dispatch",
      "daemon/workspace-roster",
      "daemon/session-execution",
      "daemon/cli-commands",
      "daemon/handlers/agents",
      "daemon/handlers/connection",
      "daemon/handlers/device",
      "daemon/handlers/files",
      "daemon/handlers/issues",
      "daemon/handlers/resources",
      "daemon/handlers/sessions",
      "daemon/handlers/skills",
      "daemon/handlers/workspaces",
      "workspace-folders",
      "workspace-ops",
      "chat-uploads",
      "service",
      "mac-worker-app",
      "worker-install",
      "worker-identity",
      "diagnostics",
      "worker-self-update",
      "self-update-lock",
      "self-update-status",
    ],
  },
};

const harnessModules = new Set(["session-runtime", "harness-profiles"]);
const harnessPackages = ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"];
const sandboxTokens = ["sandbox-exec", "bwrap"];

/** Server Go packages under internal/ and the packages each may import. */
export const serverPackages = {
  store: [],
  secretstore: [],
  accounts: [],
  chattitle: [],
  skillarchive: ["store"],
  builtinskills: ["skillarchive"],
  skillrepo: ["skillarchive"],
  skilltools: ["store", "skillrepo"],
  testfixture: ["store"],
  eventstream: [],
  textdiff: [],
  integrations: [],
  browserevent: ["store", "eventstream"],
  sqlitestore: ["store", "secretstore", "skillarchive", "chattitle"],
  externalaccounts: ["store", "integrations"],
  resources: ["store"],
  feishugateway: ["store", "integrations", "externalaccounts"],
  feishuevents: ["store", "integrations", "externalaccounts", "feishugateway"],
  feishu: [
    "store",
    "accounts",
    "browserevent",
    "eventstream",
    "integrations",
    "externalaccounts",
    "feishuevents",
  ],
  httpapi: "*",
};

export function dependencyClosure(modules) {
  const closure = new Map();
  const visit = (name, seen = new Set()) => {
    if (closure.has(name)) return closure.get(name);
    if (seen.has(name)) throw new Error(`module dependency cycle at ${name}`);
    seen.add(name);
    const { dependsOn } = modules[name];
    const reachable = new Set();
    if (dependsOn !== "*")
      for (const dependency of dependsOn) {
        if (!modules[dependency])
          throw new Error(`${name} depends on unknown module ${dependency}`);
        reachable.add(dependency);
        for (const indirect of visit(dependency, seen)) reachable.add(indirect);
      }
    closure.set(name, reachable);
    return reachable;
  };
  for (const name of Object.keys(modules)) visit(name);
  return closure;
}

export function importSpecifiers(source) {
  const specifiers = [];
  const pattern =
    /(?:^|[^\w.])(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']|(?:^|[^\w.])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;
  for (const match of source.matchAll(pattern))
    specifiers.push(match[1] ?? match[2] ?? match[3]);
  return specifiers;
}

function sourceFiles(directory, extension) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(entry.parentPath, entry.name));
}

export function auditWorker(
  modules = workerModules,
  sourceRoot = workerSource,
) {
  const violations = [];
  const owner = new Map();
  for (const [name, module] of Object.entries(modules))
    for (const file of module.files) {
      if (owner.has(file))
        throw new Error(
          `${file} is assigned to ${owner.get(file)} and ${name}`,
        );
      owner.set(file, name);
    }
  const closure = dependencyClosure(modules);
  const present = new Set();

  for (const path of sourceFiles(sourceRoot, ".ts")) {
    const file = relative(sourceRoot, path).replace(/\.ts$/, "");
    present.add(file);
    const from = owner.get(file);
    if (!from) {
      violations.push(`worker: ${file} is not assigned to a module`);
      continue;
    }
    const source = readFileSync(path, "utf8");
    // SDKs are also loaded through `import(packageName)`, so match the name.
    if (!harnessModules.has(from))
      for (const name of harnessPackages)
        if (source.includes(`"${name}"`) || source.includes(`'${name}'`))
          violations.push(`worker: ${file} (${from}) loads ${name}`);
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = normalize(join(dirname(file), specifier)).replace(
        /\.js$/,
        "",
      );
      const to = owner.get(target);
      if (!to || to === from) continue;
      const allowed =
        to !== "composition" &&
        (modules[from].dependsOn === "*" || closure.get(from).has(to));
      if (!allowed)
        violations.push(`worker: ${file} (${from}) imports ${target} (${to})`);
    }
    if (from !== "sandbox")
      for (const token of sandboxTokens)
        if (new RegExp(`\\b${token}\\b`).test(source))
          violations.push(`worker: ${file} (${from}) spells ${token}`);
  }
  for (const file of owner.keys())
    if (!present.has(file))
      violations.push(`worker: assigned file ${file} does not exist`);
  return violations;
}

export function auditServerPackages(
  packages = serverPackages,
  internal = serverInternal,
) {
  const violations = [];
  const prefix = "github.com/foundry-dev/foundry/apps/server/internal/";
  for (const entry of readdirSync(internal, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const allowed = packages[name];
    if (allowed === undefined) {
      violations.push(`server: package ${name} has no declared dependencies`);
      continue;
    }
    const imported = new Set();
    for (const path of sourceFiles(join(internal, name), ".go")) {
      if (path.endsWith("_test.go")) continue;
      for (const match of readFileSync(path, "utf8").matchAll(/"([^"\s]+)"/g))
        if (match[1].startsWith(prefix))
          imported.add(match[1].slice(prefix.length).split("/")[0]);
    }
    if (allowed === "*") continue;
    for (const dependency of [...imported].sort())
      // A package's own subpackages (e.g. its test doubles) may import it.
      if (dependency !== name && !allowed.includes(dependency))
        violations.push(`server: package ${name} imports ${dependency}`);
  }
  return violations;
}

export function storeInterfaceMethods(internal = serverInternal) {
  const source = readFileSync(join(internal, "store/store.go"), "utf8");
  const body = source.match(/type Store interface \{([\s\S]*?)\n\}/);
  if (!body) throw new Error("store.Store interface not found");
  return body[1].split("\n").filter((line) => /^\s*[A-Z]\w*\(/.test(line))
    .length;
}

function main() {
  const violations = [...auditWorker(), ...auditServerPackages()].sort();
  const methods = storeInterfaceMethods();
  const current = { storeInterfaceMethods: methods, violations };
  const baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, "utf8"))
    : undefined;

  const recorded = new Set(baseline?.violations ?? []);
  const added = violations.filter((violation) => !recorded.has(violation));
  const removed = [...recorded].filter(
    (violation) => !violations.includes(violation),
  );
  const methodLimit = baseline?.storeInterfaceMethods;
  const grew = methodLimit !== undefined && methods > methodLimit;

  if (process.env.FOUNDRY_AUDIT_UPDATE === "1") {
    if (baseline && (added.length || grew)) {
      console.error("Refusing to record new module boundary violations:");
      for (const violation of added) console.error(`- ${violation}`);
      if (grew)
        console.error(
          `- store.Store grew from ${methodLimit} to ${methods} methods`,
        );
      process.exit(1);
    }
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    console.log(
      `Module boundary baseline written: ${violations.length} violations, ${methods} store.Store methods.`,
    );
    return;
  }

  const problems = [];
  if (!baseline) problems.push(`missing ${relative(root, baselinePath)}`);
  for (const violation of added) problems.push(`new: ${violation}`);
  if (grew)
    problems.push(
      `store.Store grew from ${methodLimit} to ${methods} methods; add a module-scoped interface instead`,
    );
  for (const violation of removed)
    problems.push(`resolved but still in baseline: ${violation}`);
  if (methodLimit !== undefined && methods < methodLimit)
    problems.push(
      `store.Store shrank from ${methodLimit} to ${methods} methods; shrink the baseline`,
    );

  if (problems.length) {
    console.error("Module boundary audit failed:");
    for (const problem of problems) console.error(`- ${problem}`);
    console.error(
      "- See docs/architecture-modules.md §3.1. After removing violations, run FOUNDRY_AUDIT_UPDATE=1 pnpm audit:modules.",
    );
    process.exit(1);
  }
  console.log(
    `Module boundary audit passed with ${violations.length} tracked violations and ${methods} store.Store methods.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
