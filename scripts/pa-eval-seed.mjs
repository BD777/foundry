#!/usr/bin/env node
// Seeds a fresh PA-1 eval database (already migrated by the server, server
// stopped) for scripts/pa-eval-run.mjs --stack-dir.
//
// usage: node scripts/pa-eval-seed.mjs <fresh.db> <username> <evalSetDir>
//          [--profile ID] [--execution-default KIND,PROVIDER,RUNTIME,MODEL,EFFORT]
//
// Written with direct SQL, not through the server's API: the fixture
// projects sit on the person's own (offline) computers, which no API can
// register without a paired worker. What is written:
// - from the eval set's index.json: one disconnected device per computer,
//   one project per entry (owner: <username>) and its top-level files; the
//   project's folder under the stack's run folder, with those files and its
//   instruction file (pa-eval-fixture.mjs populateProject). The person's
//   chats there are written by the run, up to each case's week
//   (pa-eval-fixture.mjs applyHistory);
// - connector metadata from the dev DB, opened read-only, column by column:
//   external accounts (kind, status) bound to the index's projects and their
//   bindings, and device-held connector bindings on those projects. Labels
//   are replaced with neutral ones; no subject, scopes, tokens or secrets are
//   read, and no secret record is written, so a seeded account is listed but
//   cannot reach its service (FOUNDRY_INTEGRATIONS=off as well);
// - --profile ID: a server profile row and its encrypted secret, copied from
//   the dev DB read-only (never decrypted); when --execution-default names
//   the same profile, the row's default model is the default's model. A
//   device-origin profile (limen_default) needs no row: the eval's worker
//   reports it.
// - --execution-default: the user's global execution default row.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { displayName, populateProject } from "./pa-eval-fixture.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return "";
  const [, value] = argv.splice(i, 2);
  return value || "";
};
const profileId = flag("--profile");
// The stack's folder (the database is in its data folder).
const stackDir = resolve(dirname(argv[0]), "..");
const executionDefault = flag("--execution-default");
const [dbPath, username, evalDir] = argv;
if (!dbPath || !username || !evalDir)
  throw new Error(
    "usage: pa-eval-seed.mjs <fresh.db> <username> <evalSetDir> [--profile ID] [--execution-default ...]",
  );
const liveDB = resolve(homedir(), ".foundry/server/foundry.db");
if (resolve(dbPath) === liveDB) throw new Error("refusing the live database");

const index = JSON.parse(readFileSync(resolve(evalDir, "index.json"), "utf8"));
if (index.projects.some((p) => !Array.isArray(p.history)))
  throw new Error(
    `${evalDir}/index.json has no project history: build the set again (pa-eval-build.mjs)`,
  );

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
const user = db
  .prepare("SELECT id FROM users WHERE username = ?")
  .get(username);
if (!user) throw new Error(`no user ${username}`);
const now = new Date().toISOString();
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const mac = (computer) => /mac/i.test(computer);

const dev = new DatabaseSync(liveDB, { readOnly: true });
dev.exec("PRAGMA query_only = 1");

const counts = { devices: 0, workspaces: 0, files: 0 };
const seededConnectors = { accounts: [], bindings: [], deviceConnectors: [] };
db.exec("BEGIN");
try {
  const devices = new Map();
  for (const computer of [...new Set(index.projects.map((p) => p.computer))]) {
    const id = `dev_pa1-${slug(computer)}`;
    devices.set(computer, id);
    const payload = {
      id,
      label: computer,
      status: "disconnected",
      lastSeenLabel: "offline",
    };
    db.prepare(
      "INSERT INTO devices (id, label, status, last_seen_label, payload_json, updated_at) VALUES (?, ?, 'disconnected', 'offline', ?, ?)",
    ).run(id, computer, JSON.stringify(payload), now);
    // No identity row: the fixture computer's Worker pairs with this id (its
    // device.json asks for it), and the server records the identity then.
    counts.devices++;
  }

  for (const p of index.projects) {
    const deviceId = devices.get(p.computer);
    // Each computer's project folder is real, under the stack's run folder
    // (the fixture's computers are this host, sandboxed): a dispatch finds a
    // folder to work in, and the computer reports its files.
    const localPath = populateProject(stackDir, p);
    const name = displayName(p);
    const payload = {
      id: p.workspaceId,
      name,
      localPath,
      baseline: "",
      contextSummary: "",
      acceptedCount: 0,
      resolvedCount: 0,
      deviceId,
      deviceLabel: p.computer,
    };
    db.prepare(
      `INSERT INTO workspaces (id, name, local_path, baseline, context_summary, accepted_count, resolved_count, payload_json, updated_at, device_id, kind, archived_at, purpose)
       VALUES (?, ?, ?, '', '', 0, 0, ?, ?, ?, 'project', '', '')`,
    ).run(
      p.workspaceId,
      name,
      localPath,
      JSON.stringify(payload),
      now,
      deviceId,
    );
    db.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, added_by, created_at) VALUES (?, ?, 'owner', ?, ?)",
    ).run(p.workspaceId, user.id, user.id, now);
    counts.workspaces++;

    for (const entry of p.files || []) {
      const directory = entry.endsWith("/");
      const path = entry.replace(/\/$/, "");
      const id = `file_${p.workspaceId.replace(/[^a-zA-Z0-9]/g, "_")}_${createHash("sha1").update(path).digest("hex").slice(0, 12)}`;
      const kind = directory ? "directory" : "file";
      db.prepare(
        "INSERT INTO workspace_files (id, workspace_id, path, kind, payload_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        p.workspaceId,
        path,
        kind,
        JSON.stringify({
          id,
          workspaceId: p.workspaceId,
          path,
          name: path,
          kind,
          sizeLabel: directory ? "directory" : "file",
          updatedLabel: "local",
        }),
        now,
      );
      counts.files++;
    }
  }

  // Connector metadata bound to the index's projects (dev DB, read-only).
  const projectIds = index.projects.map((p) => p.workspaceId);
  const marks = projectIds.map(() => "?").join(", ");
  const neutralLabel = {
    feishu: () => "PA1 Eval",
    cloudflare: () => "PA1 Eval",
    openlark: () => "work-dev OpenLark（内网）",
  };
  const bindings = dev
    .prepare(
      `SELECT workspace_id, account_id, access FROM external_account_bindings WHERE workspace_id IN (${marks})`,
    )
    .all(...projectIds);
  const accountIds = [...new Set(bindings.map((b) => b.account_id))];
  for (const accountId of accountIds) {
    const a = dev
      .prepare(
        "SELECT id, provider, app_id, mode, status, keep_alive FROM external_accounts WHERE id = ?",
      )
      .get(accountId);
    const app = dev
      .prepare(
        "SELECT id, provider, visibility, created_via FROM external_provider_apps WHERE id = ?",
      )
      .get(a.app_id);
    const label = (neutralLabel[a.provider] || (() => a.provider))();
    db.prepare(
      `INSERT OR IGNORE INTO external_provider_apps (id, provider, owner_user_id, visibility, label, client_id, created_via, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      app.id,
      app.provider,
      user.id,
      app.visibility,
      `${app.provider} (pa1 fixture)`,
      `pa1-fixture-${slug(app.id)}`,
      app.created_via,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO external_accounts (id, provider, app_id, owner_user_id, label, mode, status, keep_alive, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      a.id,
      a.provider,
      a.app_id,
      user.id,
      label,
      a.mode,
      a.status,
      now,
      now,
    );
    seededConnectors.accounts.push({
      id: a.id,
      kind: a.provider,
      label,
      mode: a.mode,
      status: a.status,
    });
  }
  for (const b of bindings) {
    db.prepare(
      "INSERT INTO external_account_bindings (workspace_id, account_id, granted_by, created_at, access) VALUES (?, ?, ?, ?, ?)",
    ).run(b.workspace_id, b.account_id, user.id, now, b.access);
    seededConnectors.bindings.push({
      workspaceId: b.workspace_id,
      accountId: b.account_id,
    });
  }
  const projectDevice = new Map(
    index.projects.map((p) => [p.workspaceId, devices.get(p.computer)]),
  );
  for (const b of dev
    .prepare(
      `SELECT workspace_id, kind, members FROM device_connector_bindings WHERE workspace_id IN (${marks})`,
    )
    .all(...projectIds)) {
    const deviceId = projectDevice.get(b.workspace_id);
    db.prepare(
      `INSERT OR IGNORE INTO device_connector_states (device_id, kind, status, installed, signed_in, checked_at)
       VALUES (?, ?, 'ready', 1, 1, ?)`,
    ).run(deviceId, b.kind, now);
    db.prepare(
      "INSERT INTO device_connector_bindings (workspace_id, kind, device_id, members, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(b.workspace_id, b.kind, deviceId, b.members, user.id, now);
    seededConnectors.deviceConnectors.push({
      workspaceId: b.workspace_id,
      kind: b.kind,
      deviceId,
    });
  }

  if (profileId) {
    const profile = dev
      .prepare("SELECT * FROM profiles WHERE id = ?")
      .get(profileId);
    if (!profile)
      throw new Error(`no server profile ${profileId} in the dev DB`);
    profile.owner_user_id = user.id;
    // The default names this profile: its own default model follows, so
    // summaries started before the assistant's settings exist run on it too.
    const [, defaultProvider, , defaultModel] = executionDefault.split(",");
    if (defaultProvider === profileId && defaultModel)
      profile.model = defaultModel;
    const cols = Object.keys(profile);
    db.prepare(
      `INSERT INTO profiles (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ).run(...cols.map((c) => profile[c]));
    const secret = dev
      .prepare("SELECT * FROM secret_records WHERE id = ?")
      .get(`agent-profile:${profileId}`);
    if (!secret) throw new Error(`no secret for ${profileId}`);
    const scols = Object.keys(secret);
    db.prepare(
      `INSERT INTO secret_records (${scols.join(", ")}) VALUES (${scols.map(() => "?").join(", ")})`,
    ).run(...scols.map((c) => secret[c]));
  }

  if (executionDefault) {
    const [kind, provider, runtime, model, effort] =
      executionDefault.split(",");
    db.prepare(
      `INSERT INTO execution_defaults (owner_user_id, workspace_id, provider_kind, provider_id, runtime, model, effort, updated_by, updated_at)
       VALUES (?, '', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(user.id, kind, provider, runtime, model, effort || "", user.id, now);
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  dev.close();
}
db.close();
console.log(
  JSON.stringify(
    {
      ...counts,
      profile: profileId || null,
      executionDefault: executionDefault || null,
      connectors: seededConnectors,
    },
    null,
    1,
  ),
);
