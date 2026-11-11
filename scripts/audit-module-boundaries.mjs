#!/usr/bin/env node
// Module boundary guard for the layering in docs/architecture-modules.md §3.1.
//
// Worker (packages/worker/src):
//   1. Folders are modules: every source file sits in the folder of exactly
//      one module below (nearest enclosing folder wins); only the declared
//      package entry points sit at the top level.
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
// Sealed modules (docs/connectors.md, "模块边界"):
//   6. Worker: files outside a sealed folder import only its entry file.
//   7. Server: a sealed module's inner packages are imported, inside
//      httpapi, only by the files that serve that module (and the
//      composition files server.go and routes.go).
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

/**
 * Worker modules: direct dependencies and the folders that hold them. A file
 * belongs to the module whose folder is its nearest enclosing one; the only
 * files outside a module folder are the package entry points listed in
 * `entries` (bin targets and the daemon's server link). Paths are relative to
 * packages/worker/src, without .ts.
 */
export const workerModules = {
  platform: { dependsOn: [], folders: ["platform"] },
  device: { dependsOn: ["platform"], folders: ["device"] },
  concurrency: {
    dependsOn: ["platform", "device"],
    folders: ["concurrency"],
  },
  sandbox: { dependsOn: ["platform"], folders: ["sandbox"] },
  "candidate-store": { dependsOn: ["platform"], folders: ["candidate-store"] },
  transport: { dependsOn: ["device"], folders: ["transport"] },
  workspace: {
    dependsOn: ["candidate-store", "device"],
    folders: ["workspace"],
  },
  material: { dependsOn: ["candidate-store"], folders: ["material"] },
  harness: { dependsOn: ["device"], folders: ["harness"] },
  skills: { dependsOn: ["transport", "harness"], folders: ["skills"] },
  resources: { dependsOn: ["platform"], folders: ["resources"] },
  "native-work": { dependsOn: ["platform"], folders: ["native-work"] },
  "session-work": {
    dependsOn: ["transport", "native-work"],
    folders: ["session-work"],
  },
  session: {
    dependsOn: [
      "native-work",
      "session-work",
      "resources",
      "sandbox",
      "harness",
      "skills",
      "candidate-store",
      "transport",
    ],
    folders: ["session", "connectors"],
  },
  "agent-surface": {
    dependsOn: ["session"],
    folders: ["agent-surface"],
    entries: ["foundry-cli"],
  },
  issue: {
    dependsOn: ["session", "agent-surface", "material", "workspace"],
    folders: ["issue"],
  },
  composition: {
    dependsOn: "*",
    folders: ["daemon", "execution-host", "install"],
    entries: ["cli", "daemon-connection"],
  },
};

/** Worker folders whose files only their entry file exposes (rule 6). */
export const sealedWorkerFolders = {
  connectors: "connectors/index",
  "session/preparation": "session/preparation/index",
};

const harnessModules = new Set(["session", "harness"]);
const harnessPackages = ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"];
const sandboxTokens = ["sandbox-exec", "bwrap"];

/** Server Go packages under internal/ and the packages each may import. */
export const serverPackages = {
  // Collection types the generated contract models use (scripts/generate-contracts.mjs).
  jsonempty: [],
  store: ["jsonempty"],
  secretstore: [],
  accounts: [],
  chattitle: [],
  redact: [],
  skillarchive: ["store"],
  builtinskills: ["skillarchive"],
  skillrepo: ["skillarchive"],
  skilltools: ["store", "skillrepo"],
  testfixture: ["store"],
  eventstream: [],
  textdiff: [],
  textcut: [],
  keylock: [],
  integrations: [],
  // Dev-only device traffic recording for the wire drift report (P2 S1);
  // goes with S3b.
  wirerecord: ["redact"],
  browserevent: ["store", "eventstream"],
  sqlitestore: [
    "store",
    "secretstore",
    "skillarchive",
    "chattitle",
    "redact",
    "personalagent",
    "permission",
  ],
  // Permission is the one policy resolver for connector access. The gateway
  // modules and the store that persists its packages may depend on it.
  permission: ["jsonempty", "store"],
  // jsonempty names the required map/list types in generated server-held
  // extension API results; it is a leaf collection package, not a policy
  // dependency or a reverse edge into the Connectors module.
  externalaccounts: [
    "store",
    "jsonempty",
    "integrations",
    "keylock",
    "permission",
  ],
  // The Server-held connectors' request pipeline: authentication, the
  // recheck, the comparison, limits and audit; each connector supplies what
  // a request is and how it travels.
  gateway: ["store", "externalaccounts", "permission"],
  connectors: [
    "store",
    "integrations",
    "externalaccounts",
    "gateway",
    "permission",
  ],
  // Pure equivalent-model choice and retry timing; callers own storage,
  // transport and inference.
  modelpool: [],
  resources: ["store", "textcut"],
  // The assistant's rules (personalagent) use the centralized permission
  // decision, store, the session lifecycle and workspace digests. Its flows
  // reach everything else through ports httpapi implements, never the
  // reverse. A package's subpackages count as the package here, so
  // workspacedigest importing the rules is no cycle.
  personalagent: [
    "store",
    "sessions",
    "workspacedigest",
    "redact",
    "textcut",
    "permission",
  ],
  sessionwork: ["store"],
  usagestats: ["store", "jsonempty"],
  // Session system alerts: failed, canceled or stuck children, told to the
  // session that started the turn.
  sessionalerts: ["store", "sessions", "textcut"],
  // The session lifecycle; httpapi implements its ports and never the
  // reverse.
  sessions: ["store", "eventstream", "browserevent"],
  // An Issue's lifecycle, whichever entry asks; httpapi implements its
  // port and never the reverse.
  issues: ["store", "eventstream", "browserevent", "sessions", "keylock"],
  workspacedigest: ["store", "personalagent", "redact", "textcut"],
  feishugateway: [
    "store",
    "integrations",
    "externalaccounts",
    "gateway",
    "permission",
  ],
  feishuevents: [
    "store",
    "integrations",
    "externalaccounts",
    "feishugateway",
    "textcut",
  ],
  feishu: [
    "store",
    "accounts",
    "browserevent",
    "eventstream",
    "integrations",
    "externalaccounts",
    "feishuevents",
    "textcut",
  ],
  httpapi: "*",
};

/**
 * Server packages inside a sealed module and the httpapi files that may
 * import them (rule 7). The Connectors module's face is internal/connectors;
 * its server-held engine, the Feishu gateway and the event connections are
 * used by the connector HTTP files only.
 */
export const sealedServerPackages = {
  externalaccounts:
    /^(appstoreconnect_connectors|connector_extension_instances|connectors|cloudflare_connectors|external_accounts|feishu)[a-z_]*\.go$/,
  gateway:
    /^(appstoreconnect_connectors|connector_extension_instances|connectors|cloudflare_connectors|external_accounts|feishu)[a-z_]*\.go$/,
  feishugateway: /^(connectors|external_accounts|feishu)[a-z_]*\.go$/,
  feishuevents: /^(connectors|external_accounts|feishu)[a-z_]*\.go$/,
};
const httpapiCompositionFiles = new Set(["server.go", "routes.go"]);

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

/**
 * The module each worker file belongs to, by folder (rule 1). Returns the
 * owner map and the violations of the layout itself.
 */
export function workerFileOwners(modules, files) {
  const violations = [];
  const folderOwner = new Map();
  const entryOwner = new Map();
  for (const [name, module] of Object.entries(modules)) {
    for (const folder of module.folders ?? []) {
      if (folderOwner.has(folder))
        throw new Error(
          `${folder}/ is assigned to ${folderOwner.get(folder)} and ${name}`,
        );
      folderOwner.set(folder, name);
    }
    for (const entry of module.entries ?? []) {
      if (entryOwner.has(entry))
        throw new Error(
          `${entry} is assigned to ${entryOwner.get(entry)} and ${name}`,
        );
      entryOwner.set(entry, name);
    }
  }
  const owner = new Map();
  for (const file of files) {
    if (!file.includes("/")) {
      if (entryOwner.has(file)) owner.set(file, entryOwner.get(file));
      else
        violations.push(
          `worker: ${file} sits outside a module folder; move it into one`,
        );
      continue;
    }
    let folder = file.slice(0, file.lastIndexOf("/"));
    while (!folderOwner.has(folder) && folder.includes("/"))
      folder = folder.slice(0, folder.lastIndexOf("/"));
    if (folderOwner.has(folder)) owner.set(file, folderOwner.get(folder));
    else
      violations.push(
        `worker: ${file} is in ${file.split("/")[0]}/, which no module owns`,
      );
  }
  const directories = new Set(
    files.flatMap((file) =>
      file
        .split("/")
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
    ),
  );
  for (const [folder, name] of folderOwner)
    if (!directories.has(folder))
      violations.push(`worker: ${name} folder ${folder}/ does not exist`);
  for (const [entry, name] of entryOwner)
    if (!files.includes(entry))
      violations.push(`worker: ${name} entry ${entry} does not exist`);
  return { owner, violations };
}

export function auditWorker(
  modules = workerModules,
  sourceRoot = workerSource,
) {
  const paths = sourceFiles(sourceRoot, ".ts");
  const files = paths.map((path) =>
    relative(sourceRoot, path).replace(/\.ts$/, ""),
  );
  const { owner, violations } = workerFileOwners(modules, files);
  const closure = dependencyClosure(modules);

  for (const [index, path] of paths.entries()) {
    const file = files[index];
    const from = owner.get(file);
    if (!from) continue;
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
      for (const [folder, entry] of Object.entries(sealedWorkerFolders))
        if (
          target.startsWith(`${folder}/`) &&
          target !== entry &&
          !file.startsWith(`${folder}/`)
        )
          violations.push(
            `worker: ${file} imports ${target} inside ${folder}/; use ${entry}`,
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

export function auditSealedServerPackages(
  sealed = sealedServerPackages,
  internal = serverInternal,
) {
  const violations = [];
  const prefix = "github.com/foundry-dev/foundry/apps/server/internal/";
  const httpapi = join(internal, "httpapi");
  for (const path of sourceFiles(httpapi, ".go")) {
    const file = relative(httpapi, path);
    if (file.endsWith("_test.go") || httpapiCompositionFiles.has(file))
      continue;
    const source = readFileSync(path, "utf8");
    for (const [name, allowed] of Object.entries(sealed))
      if (source.includes(`"${prefix}${name}"`) && !allowed.test(file))
        violations.push(
          `server: httpapi/${file} imports ${name}, which only the module's own HTTP files use`,
        );
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
  const violations = [
    ...auditWorker(),
    ...auditServerPackages(),
    ...auditSealedServerPackages(),
  ].sort();
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
