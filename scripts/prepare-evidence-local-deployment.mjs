// Pre-deployment safety for one stack: refuse while work is in flight, then
// take a restore point so a bad rollout can be undone.
//
// The snapshot is a copy-on-write clone, not a byte copy. On APFS a clone of
// the database shares blocks with the live file, so a restore point costs
// roughly zero bytes and zero seconds no matter how large the database grows.
// Cloning can tear if a writer commits mid-copy, so every clone is verified
// with `PRAGMA quick_check` and falls back to `sqlite3 .backup` when the check
// fails or the filesystem has no clone support.
//
// Restore points are kept under a retention limit (--keep, default 10) because
// most of them are interchangeable. The exception is a snapshot taken under a
// schema that later changed: that one holds the last state the old schema ever
// had and cannot be reproduced, so it is marked a boundary and kept forever.
// Snapshots predating this manifest format are never pruned automatically;
// pass --prune-legacy to remove them. Before any snapshot is removed, rows it
// holds that the live database has since lost are carried into a salvage
// archive: reclaiming disk space must not be a way to lose history.
//
// The default stack uses `dev.foundry.*` and `~/.foundry`; pass
// `--stack <name>` for a stack created by scripts/dev-stack.mjs. The database,
// the server binary and the commit recorded in the manifest all come from that
// stack's own worktree, so the script may be run from any checkout.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const stack = flag("--stack") ?? "main";
const keep = Math.max(1, Number(flag("--keep") ?? 10));
const pruneLegacy = args.includes("--prune-legacy");
const stateRoot =
  stack === "main"
    ? resolve(homedir(), ".foundry")
    : resolve(homedir(), ".foundry-stacks", stack);
const label = (service) =>
  stack === "main"
    ? `dev.foundry.${service}`
    : `dev.foundry.${stack}.${service}`;

// A database belongs to a stack, not to the checkout this script happens to
// live in. Running it from one worktree for another stack must not snapshot
// the wrong database under the right name: a mislabelled restore point is
// worse than none, because restoring it overwrites the stack it names.
const worktreeOf = (name) => {
  if (name === "main") {
    const plist = resolve(
      homedir(),
      "Library/LaunchAgents/dev.foundry.server.plist",
    );
    const program = existsSync(plist)
      ? /<string>([^<]*apps\/server\/\.tmp\/foundry-server)<\/string>/.exec(
          readFileSync(plist, "utf8"),
        )
      : undefined;
    // Before the default stack is ever deployed there is no plist to read.
    return program
      ? resolve(program[1], "../../../..")
      : resolve(import.meta.dirname, "..");
  }
  const registryPath = resolve(homedir(), ".foundry-stacks", "stacks.json");
  const entry = existsSync(registryPath)
    ? JSON.parse(readFileSync(registryPath, "utf8")).find(
        (candidate) => candidate.name === name,
      )
    : undefined;
  if (!entry)
    throw new Error(
      `unknown stack ${name}: scripts/dev-stack.mjs list shows the stacks that exist`,
    );
  return entry.worktree;
};

const root = worktreeOf(stack);
const database = resolve(root, "apps/server/.data/foundry.db");
if (!existsSync(database))
  throw new Error(`stack ${stack} has no database at ${database}`);
const sqlite = (file, query) =>
  execFileSync("sqlite3", [file, query], { encoding: "utf8" }).trim();
const digest = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);
const digestFile = (file) => digest(readFileSync(file));

const active =
  Number(
    sqlite(
      database,
      "SELECT count(*) FROM runs WHERE status NOT IN ('completed','failed','canceled','cancelled');",
    ),
  ) +
  Number(
    sqlite(
      database,
      "SELECT count(*) FROM agent_sessions WHERE status NOT IN ('completed','failed','canceled','cancelled');",
    ),
  );
if (active) throw new Error("Active work exists; do not restart services.");

const privateRoot = resolve(homedir(), ".config/foundry");
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
chmodSync(privateRoot, 0o700);

const prefix = `pre-evidence-${stack === "main" ? "" : `${stack}-`}`;
// Legacy stacks share the default prefix, so a directory is only ours when its
// manifest says so; unlabelled directories are attributed by name.
const readManifest = (dir) => {
  const file = resolve(dir, "manifest.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
const existing = readdirSync(privateRoot)
  .filter((name) => name.startsWith("pre-evidence-"))
  .map((name) => {
    const path = resolve(privateRoot, name);
    if (!statSync(path).isDirectory()) return undefined;
    return {
      name,
      path,
      mtime: statSync(path).mtimeMs,
      manifest: readManifest(path),
    };
  })
  .filter(Boolean)
  .filter((entry) =>
    entry.manifest
      ? entry.manifest.stack === stack
      : entry.name.startsWith(prefix),
  )
  .sort((left, right) => left.mtime - right.mtime);

// The schema is the only part of a snapshot that a later build can invalidate.
const schemaDigest = digest(
  sqlite(
    database,
    "SELECT type||' '||name||' '||coalesce(sql,'') FROM sqlite_master ORDER BY name;",
  ),
);
const previous = existing.filter((entry) => entry.manifest).at(-1);
const boundaries = [];
if (
  previous &&
  previous.manifest.schemaDigest !== schemaDigest &&
  !previous.manifest.boundary
) {
  // The schema moved since that snapshot, so it holds the last state the old
  // schema ever had. Nothing can reproduce it; keep it out of the rotation.
  previous.manifest.boundary = {
    markedAt: new Date().toISOString(),
    nextSchemaDigest: schemaDigest,
  };
  writeFileSync(
    resolve(previous.path, "manifest.json"),
    `${JSON.stringify(previous.manifest, undefined, 2)}\n`,
    { mode: 0o600 },
  );
  boundaries.push(previous.name);
}

const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").slice(0, 15);
let backup = resolve(privateRoot, `${prefix}${stamp}`);
for (let attempt = 1; existsSync(backup); attempt += 1) {
  backup = resolve(privateRoot, `${prefix}${stamp}-${attempt}`);
}
mkdirSync(backup, { mode: 0o700 });

// Fold the write-ahead log into the database so a clone of the single file is
// a complete snapshot.
sqlite(database, "PRAGMA wal_checkpoint(TRUNCATE);");
const snapshotDatabase = resolve(backup, "foundry.db");
const cloneFile = (source, target) => {
  try {
    execFileSync("cp", ["-c", source, target]);
    return "clone";
  } catch {
    copyFileSync(source, target);
    return "copy";
  }
};
let method = cloneFile(database, snapshotDatabase);
let integrity = sqlite(snapshotDatabase, "PRAGMA quick_check;");
if (integrity !== "ok") {
  // A writer commited mid-clone. Fall back to sqlite's own backup, which
  // serialises against writers at the cost of a real byte copy.
  rmSync(snapshotDatabase, { force: true });
  execFileSync("sqlite3", [
    database,
    `.backup '${snapshotDatabase.replaceAll("'", "''")}'`,
  ]);
  method = "backup";
  integrity = sqlite(snapshotDatabase, "PRAGMA quick_check;");
  if (integrity !== "ok")
    throw new Error(`Snapshot failed integrity check: ${integrity}`);
}
chmodSync(snapshotDatabase, 0o600);

const binary = resolve(root, "apps/server/.tmp/foundry-server");
if (existsSync(binary)) {
  cloneFile(binary, resolve(backup, "foundry-server"));
  chmodSync(resolve(backup, "foundry-server"), 0o600);
}
for (const service of ["server", "web", "worker", "worker-watchdog"]) {
  const plist = resolve(
    homedir(),
    `Library/LaunchAgents/${label(service)}.plist`,
  );
  // Named stacks have no watchdog; the default stack does.
  if (!existsSync(plist)) continue;
  copyFileSync(plist, resolve(backup, `${service}.plist`));
  chmodSync(resolve(backup, `${service}.plist`), 0o600);
}
const registry = resolve(stateRoot, "workspaces.json");
if (existsSync(registry))
  copyFileSync(registry, resolve(backup, "workspaces.json"));

const git = (...argv) => {
  try {
    return execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
writeFileSync(
  resolve(backup, "manifest.json"),
  `${JSON.stringify(
    {
      stack,
      takenAt: new Date().toISOString(),
      schemaDigest,
      databaseBytes: statSync(database).size,
      method,
      integrity,
      commit: git("rev-parse", "HEAD"),
      dirty: git("status", "--porcelain") !== "",
      binaryDigest: existsSync(binary) ? digestFile(binary) : undefined,
      stateRoot,
    },
    undefined,
    2,
  )}\n`,
  { mode: 0o600 },
);

const prunable = existing.filter(
  (entry) => entry.manifest && !entry.manifest.boundary,
);
const pruned = prunable.slice(0, Math.max(0, prunable.length - (keep - 1)));
for (const entry of pruned)
  rmSync(entry.path, { recursive: true, force: true });

// Dropping a snapshot is only safe when the live database still holds
// everything it held. A row deleted since exists nowhere else, so carry those
// rows into a salvage archive before the directory goes. Reclaiming disk space
// must not be a way to lose history.
const legacy = existing.filter((entry) => !entry.manifest);
const archive = resolve(privateRoot, `salvaged-${stamp}.db`);
const salvaged = [];

const columnsOf = (file, table) =>
  sqlite(file, `PRAGMA table_info('${table}');`)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("|"));

const salvage = (entry) => {
  const file = resolve(entry.path, "foundry.db");
  if (!existsSync(file)) return;
  const tables = sqlite(
    file,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
  )
    .split("\n")
    .filter(Boolean);
  for (const table of tables) {
    const info = columnsOf(file, table);
    const names = info.map((column) => column[1]);
    const keyed = info.filter((column) => column[5] !== "0").map((c) => c[1]);
    // Without a declared key a row is its own identity.
    const key = keyed.length ? keyed : names;
    const columns = names.map((name) => `"${name}"`).join(",");
    const matches = (alias) =>
      key.map((name) => `${alias}."${name}"=b."${name}"`).join(" AND ");
    const liveHas =
      Number(
        sqlite(
          database,
          `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='${table}';`,
        ),
      ) > 0;
    const liveKey = liveHas
      ? columnsOf(database, table)
          .filter((column) => column[5] !== "0")
          .map((column) => column[1])
      : [];
    // A renamed key makes the two sides incomparable; treat the whole table as
    // unique rather than guess a correspondence.
    const comparable = liveHas && liveKey.join() === keyed.join();
    const absent = comparable
      ? `NOT EXISTS (SELECT 1 FROM live."${table}" m WHERE ${matches("m")})`
      : "1";
    const attach = `ATTACH '${database}' AS live; ATTACH '${archive}' AS arc;`;
    const rows = Number(
      sqlite(
        file,
        `${attach} SELECT count(*) FROM main."${table}" b WHERE ${absent};`,
      ),
    );
    if (!rows) continue;
    // Snapshots of different ages disagree on a table's columns, so each shape
    // gets its own archive table instead of failing the insert.
    let target = table;
    sqlite(
      file,
      `${attach} CREATE TABLE IF NOT EXISTS arc."${target}" AS SELECT ${columns} FROM main."${table}" WHERE 0;`,
    );
    const archived = columnsOf(archive, target).map((column) => column[1]);
    if (archived.join() !== names.join()) {
      target = `${table}__${digest(names.join())}`;
      sqlite(
        file,
        `${attach} CREATE TABLE IF NOT EXISTS arc."${target}" AS SELECT ${columns} FROM main."${table}" WHERE 0;`,
      );
    }
    // Snapshots overlap heavily, so the same lost row arrives many times.
    const before = Number(sqlite(archive, `SELECT count(*) FROM "${target}";`));
    sqlite(
      file,
      `${attach} INSERT INTO arc."${target}" (${columns}) SELECT ${columns} FROM main."${table}" b WHERE ${absent} AND NOT EXISTS (SELECT 1 FROM arc."${target}" a WHERE ${matches("a")});`,
    );
    const added =
      Number(sqlite(archive, `SELECT count(*) FROM "${target}";`)) - before;
    if (!added) continue;
    salvaged.push({
      snapshot: entry.name,
      table: target,
      rows: added,
      reason: comparable ? "deleted since" : "table or key gone from live",
    });
  }
};

if (pruneLegacy) {
  for (const entry of legacy) salvage(entry);
  if (existsSync(archive)) chmodSync(archive, 0o600);
  for (const entry of legacy)
    rmSync(entry.path, { recursive: true, force: true });
}

console.log(
  JSON.stringify({
    stack,
    backup,
    stateRoot,
    activeWork: active,
    method,
    schemaDigest,
    markedBoundary: boundaries,
    pruned: pruned.map((entry) => entry.name),
    legacy: pruneLegacy
      ? {
          removed: legacy.length,
          salvaged: salvaged.length ? { archive, rows: salvaged } : null,
        }
      : { kept: legacy.length, hint: "--prune-legacy" },
  }),
);
