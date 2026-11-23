// The eval's fixture projects as a production digest sees them
// (scripts/pa-eval-seed.mjs writes them, scripts/pa-eval-run.mjs moves their
// history forward between cases): a real folder on the fixture computer with
// the project's top-level files and its instruction file, and the person's
// chats there up to a cutoff, from the eval set's index (pa-eval-build.mjs:
// `history`, `intro`, `files`).
//
// Folders live under the stack's run folder (<stack>/pa-eval), the one folder
// the fixture computers' Workers can write and see: anything else of the
// stack is outside their sandbox.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** The run folder of a stack: what the eval's Workers see. */
export const runFolder = (stackDir) => resolve(stackDir, "pa-eval");

/** A fixture project's folder on its computer. */
export const projectFolder = (stackDir, computer, name) =>
  resolve(runFolder(stackDir), "computers", computer, "workspace", name);

// The instruction files a digest reads an intro from, in its order.
const instructionFiles = ["AGENTS.md", "CLAUDE.md", "README.md"];

/**
 * Creates the project's folder with its top-level entries (empty files and
 * folders, as names say what a project holds) and writes its intro into the
 * first instruction file it has. Returns the folder.
 */
export function populateProject(stackDir, project) {
  const folder = projectFolder(
    stackDir,
    project.computer,
    displayName(project),
  );
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  for (const entry of project.files || []) {
    const path = resolve(folder, entry.replace(/\/$/, ""));
    if (!path.startsWith(folder + "/")) continue;
    if (entry.endsWith("/")) mkdirSync(path, { recursive: true, mode: 0o700 });
    else if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
  }
  // The folder's Foundry identity, as `foundry-worker init` writes it.
  mkdirSync(resolve(folder, ".foundry"), { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(folder, ".foundry", "workspace.json"),
    JSON.stringify(workspaceEntry(stackDir, project), null, 2),
    { mode: 0o600 },
  );
  const intro = (project.intro || "").trim();
  const file = instructionFiles.find((f) => (project.files || []).includes(f));
  if (intro && file)
    writeFileSync(resolve(folder, file), `${intro}\n`, { mode: 0o600 });
  return folder;
}

const registeredAt = "2026-05-01T00:00:00.000Z";

function workspaceEntry(stackDir, project) {
  return {
    id: project.workspaceId,
    name: displayName(project),
    path: projectFolder(stackDir, project.computer, displayName(project)),
    baseline: "main",
    createdAt: registeredAt,
    schemaVersion: 1,
  };
}

/**
 * A fixture computer's Worker registry (<state root>/workspaces.json): the
 * projects on that computer, as `foundry-worker init` registers them, so the
 * Worker serves them under the ids the eval set uses.
 */
export function writeRegistry(stateRoot, stackDir, projects) {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const entries = projects.map((p) => {
    const { id, name, path, baseline } = workspaceEntry(stackDir, p);
    return { id, name, path, baseline, registeredAt };
  });
  writeFileSync(
    resolve(stateRoot, "workspaces.json"),
    JSON.stringify(entries, null, 2),
    { mode: 0o600 },
  );
}

/** The name the fixture shows (a stand-in where the set's name had one). */
export const displayName = (project) => project.displayName || project.name;

// A digest reads at most 80 of a project's chats (maxHistoryItems).
const historyPerProject = 80;

const chatId = (workspaceId, item) => {
  const h = createHash("sha1")
    .update(`${workspaceId}\0${item.at}\0${item.title}\0${item.request}`)
    .digest("hex");
  const native = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return { id: `native_claude_${native}`, native };
};

/**
 * Writes each project's chats from before `cutoff` (ISO date or time; the
 * latest 80, newest first) into a stopped stack's database, replacing the
 * ones an earlier cutoff wrote, and deletes the person's digest of every
 * project whose chats changed: the server builds it again from the new
 * chats when the project's computer connects, and summarizes it at once
 * (never summarized), as production does on a first summary. Returns the
 * ids of the projects that changed.
 */
export function applyHistory(db, index, userId, cutoff, { shiftMs = 0 } = {}) {
  const changed = [];
  // Times as the replay has them: the cutoff is now, so what came just
  // before it is recent (the person's latest chats, a project's last
  // activity), as it was when the case was asked.
  const shifted = (at) => new Date(Date.parse(at) + shiftMs).toISOString();
  const setTime = db.prepare(
    "UPDATE chats SET updated_at = ?, activity_at = ?, payload_json = json_set(payload_json, '$.updatedAt', ?) WHERE id = ?",
  );
  db.exec("BEGIN");
  try {
    for (const p of index.projects) {
      const all = (p.history || []).map((item) => ({
        ...item,
        ...chatId(p.workspaceId, item),
      }));
      const wanted = all
        .filter((item) => item.at < cutoff)
        .slice(0, historyPerProject);
      const ids = new Set(all.map((item) => item.id));
      const present = db
        .prepare("SELECT id FROM chats WHERE workspace_id = ?")
        .all(p.workspaceId)
        .map((r) => r.id)
        .filter((id) => ids.has(id));
      const want = new Set(wanted.map((item) => item.id));
      const same =
        present.length === want.size && present.every((id) => want.has(id));
      if (same) {
        // Same chats, times of this cutoff (no content change: the digest
        // stays).
        for (const item of wanted) {
          const at = shifted(item.at);
          setTime.run(at, at, at, item.id);
        }
        continue;
      }
      for (const id of present)
        db.prepare("DELETE FROM chats WHERE id = ?").run(id);
      for (const item of wanted) {
        const first = item.request || item.title;
        const title = item.title || first.replace(/\s+/g, " ").slice(0, 60);
        const payload = {
          id: item.id,
          workspaceId: p.workspaceId,
          provider: "claude",
          nativeSessionId: item.native,
          title,
          preview: first,
          status: "completed",
          updatedAt: shifted(item.at),
          // The person's first message: a native chat with no turns is
          // dropped at server start.
          recentMessages: [{ role: "user", text: first }],
          readonly: false,
        };
        db.prepare(
          "INSERT INTO chats (id, title, payload_json, updated_at, workspace_id, provider, native_session_id, activity_at) VALUES (?, ?, ?, ?, ?, 'claude', ?, ?)",
        ).run(
          item.id,
          title,
          JSON.stringify(payload),
          shifted(item.at),
          p.workspaceId,
          item.native,
          shifted(item.at),
        );
      }
      db.prepare(
        "DELETE FROM workspace_digests WHERE user_id = ? AND workspace_id = ?",
      ).run(userId, p.workspaceId);
      changed.push(p.workspaceId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return changed;
}

/**
 * Where the person was when they asked: the computer they typed the
 * request on. Their latest chat there before the cutoff (written by
 * applyHistory) becomes active at `at`, as the person's own chatting on that
 * computer was; the request's own chat stays out. Works on a running
 * server's database. Returns what restorePresence puts back, or null when
 * the computer has no chat yet.
 */
export function markPresence(db, index, computer, at) {
  const projects = index.projects.filter((p) => p.computer === computer);
  const ids = new Set(
    projects.flatMap((p) =>
      (p.history || []).map((item) => chatId(p.workspaceId, item).id),
    ),
  );
  if (!projects.length) return null;
  const marks = projects.map(() => "?").join(", ");
  const latest = db
    .prepare(
      `SELECT id, updated_at, activity_at, payload_json FROM chats WHERE workspace_id IN (${marks}) ORDER BY updated_at DESC`,
    )
    .all(...projects.map((p) => p.workspaceId))
    .find((row) => ids.has(row.id));
  if (!latest) return null;
  const update = db.prepare(
    "UPDATE chats SET updated_at = ?, activity_at = ?, payload_json = ? WHERE id = ?",
  );
  const payload = JSON.parse(latest.payload_json);
  update.run(at, at, JSON.stringify({ ...payload, updatedAt: at }), latest.id);
  return {
    chatId: latest.id,
    updated_at: latest.updated_at,
    activity_at: latest.activity_at,
    payload_json: latest.payload_json,
  };
}

/** The chat markPresence moved, back at its own time. */
export function restorePresence(db, mark) {
  db.prepare(
    "UPDATE chats SET updated_at = ?, activity_at = ?, payload_json = ? WHERE id = ?",
  ).run(mark.updated_at, mark.activity_at, mark.payload_json, mark.chatId);
}

/**
 * The cutoff of each case: the Monday of the week it was asked in (its
 * `snapshot`), so nothing from its own week or later is seen. Cases are
 * grouped so that a small week joins the group before it when that group
 * started at most three weeks earlier (an earlier cutoff only hides more);
 * each group is one history move. Returned oldest first.
 */
export function cutoffGroups(cases, { minCases = 3, joinDays = 21 } = {}) {
  const byWeek = new Map();
  for (const c of cases) {
    const week = c.snapshot;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week || ""))
      throw new Error(`${c.id} has no week to cut its history at`);
    byWeek.set(week, [...(byWeek.get(week) || []), c]);
  }
  const groups = [];
  for (const week of [...byWeek.keys()].sort()) {
    const list = byWeek.get(week);
    const last = groups.at(-1);
    const days = last
      ? (Date.parse(week) - Date.parse(last.cutoff)) / 86_400_000
      : Infinity;
    if (last && list.length < minCases && days <= joinDays)
      last.cases.push(...list);
    else groups.push({ cutoff: week, cases: [...list] });
  }
  return groups;
}

// Connector metadata bound to the projects, from a database (the dev one,
// read-only): no subject, scopes, tokens or secrets, only what the seed
// writes. pa-eval-build.mjs stores the same in index.connectors.
export function connectorsOf(source, projectIds) {
  const marks = projectIds.map(() => "?").join(", ");
  const bindings = source
    .prepare(
      `SELECT workspace_id, account_id, access FROM external_account_bindings WHERE workspace_id IN (${marks})`,
    )
    .all(...projectIds);
  const accounts = [...new Set(bindings.map((b) => b.account_id))].map((id) => {
    const a = source
      .prepare(
        "SELECT id, provider, app_id, mode, status FROM external_accounts WHERE id = ?",
      )
      .get(id);
    const app = source
      .prepare(
        "SELECT id, provider, visibility, created_via FROM external_provider_apps WHERE id = ?",
      )
      .get(a.app_id);
    return { ...a, app: { ...app } };
  });
  const deviceBindings = source
    .prepare(
      `SELECT workspace_id, kind, members FROM device_connector_bindings WHERE workspace_id IN (${marks})`,
    )
    .all(...projectIds)
    .map((b) => ({ ...b }));
  return {
    bindings: bindings.map((b) => ({ ...b })),
    accounts: accounts.map((a) => ({ ...a })),
    deviceBindings,
  };
}

/**
 * The person's summarized digests of the fixture projects, to reuse at the
 * same cutoff in another stack of the same set (a parallel run's shards):
 * the rows as the server keeps them, without the person.
 */
export function exportDigests(db, userId, projectIds) {
  const marks = projectIds.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT * FROM workspace_digests WHERE user_id = ? AND summarized_at != '' AND workspace_id IN (${marks})`,
    )
    .all(userId, ...projectIds)
    .map((row) => ({ ...row, user_id: "" }));
}

/**
 * Writes exported digests for this stack's person (a stopped server's
 * database), replacing theirs. The server keeps a digest whose content is
 * unchanged, so the projects are not summarized again; one whose chats
 * differ would be. Returns how many were written.
 */
export function importDigests(db, userId, rows) {
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const digest = JSON.parse(row.digest_json);
      digest.userId = userId;
      const values = {
        ...row,
        user_id: userId,
        digest_json: JSON.stringify(digest),
        summary_session_id: "",
        summary_due_at: "",
        pending_rev: "",
      };
      db.prepare(
        "DELETE FROM workspace_digests WHERE user_id = ? AND workspace_id = ?",
      ).run(userId, row.workspace_id);
      const cols = Object.keys(values);
      db.prepare(
        `INSERT INTO workspace_digests (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ).run(...cols.map((c) => values[c]));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return rows.length;
}
