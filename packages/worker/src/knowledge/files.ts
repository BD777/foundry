import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  KnowledgeCommand,
  KnowledgeDocument,
  KnowledgeReply,
} from "@bd777/foundry-protocol";

const maxBytes = 128 * 1024;
const identifier = /^[a-zA-Z0-9_-]{1,160}$/;
const header = "<!-- foundry-knowledge-v1 ";
type RootState = {
  controlRevision: number;
  vaultId: string;
  epoch: number;
  state: "active" | "frozen" | "staged" | "retired";
  operationId: string;
};
export class KnowledgeFileError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeFileError";
  }
}
function fail(code: string, message: string): never {
  throw new KnowledgeFileError(code, message);
}
function safeID(value: string) {
  if (!identifier.test(value))
    fail("invalid_id", "Invalid knowledge identifier");
  return value;
}
function within(root: string, path: string) {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}
function rootFolder(workspace: string, relativePath: string, create: boolean) {
  if (
    isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((p) => p === ".." || p === ".git") ||
    !relativePath.trim()
  )
    fail(
      "invalid_path",
      "Knowledge location must be inside the selected workspace",
    );
  const base = realpathSync(workspace);
  const target = resolve(base, relativePath);
  if (!within(base, target))
    fail("invalid_path", "Knowledge location escapes the workspace");
  let current = base;
  for (const part of relative(base, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) {
      if (!create) fail("not_found", "Knowledge location is unavailable");
      mkdirSync(current, { mode: 0o700 });
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      fail(
        "unsafe_path",
        "Knowledge location may not traverse symlinks or files",
      );
  }
  return target;
}
function regular(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    fail(
      "unsafe_path",
      "Knowledge file must be a regular file with a single link",
    );
  if (stat.size > maxBytes * 2)
    fail("too_large", "Knowledge file exceeds the size limit");
}
function read(path: string) {
  regular(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
function atomic(path: string, value: string) {
  if (existsSync(path)) regular(path);
  const temp = join(dirname(path), `.pending-${randomUUID()}`);
  const journal = join(dirname(path), ".pending-journal.json");
  if (existsSync(journal)) regular(journal);
  const journalFD = openSync(
    journal,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(
      journalFD,
      JSON.stringify({ name: relative(dirname(path), temp), pid: process.pid }),
    );
    fsyncSync(journalFD);
  } finally {
    closeSync(journalFD);
  }
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeFileSync(fd, value, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
    if (existsSync(journal)) unlinkSync(journal);
  }
}
function clearAbandonedTemp(root: string) {
  const journal = join(root, ".pending-journal.json");
  if (!existsSync(journal)) return;
  let entry: { name: string; pid: number };
  try {
    entry = JSON.parse(read(journal));
  } catch {
    return fail("recovery_required", "Temporary write journal needs review");
  }
  if (
    !/^\.pending-[a-f0-9-]{36}$/.test(entry.name) ||
    !Number.isInteger(entry.pid) ||
    entry.pid < 1
  )
    fail("recovery_required", "Temporary write journal is invalid");
  // Only this protocol's durable journal proves a temporary file is ours.
  // withLock has already proved the old writer dead or that no writer held it.
  if (entry.pid !== process.pid) {
    try {
      process.kill(entry.pid, 0);
      fail("locked", "Temporary writer is still alive");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const temp = join(root, entry.name);
  if (existsSync(temp)) {
    regular(temp);
    unlinkSync(temp);
  }
  unlinkSync(journal);
}
function withLock<T>(root: string, fn: () => T): T {
  const lock = join(root, ".writer-lock");
  if (existsSync(lock)) {
    // Only recover an abandoned lock whose process is known to be gone. A
    // live or reused PID remains a refusal; never steal a running writer.
    const stat = lstatSync(lock);
    const pid = Number(read(lock));
    if (!Number.isInteger(pid) || pid < 1)
      fail("locked", "Knowledge writer needs recovery");
    try {
      process.kill(pid, 0);
      fail("locked", "Knowledge writer is active");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const now = lstatSync(lock);
    if (now.ino !== stat.ino || now.dev !== stat.dev)
      fail("locked", "Knowledge lock changed");
    unlinkSync(lock);
  }
  let fd: number;
  try {
    fd = openSync(
      lock,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
  } catch {
    return fail("locked", "Knowledge writer is active");
  }
  try {
    writeFileSync(fd, String(process.pid));
    fsyncSync(fd);
    clearAbandonedTemp(root);
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
function hash(body: string) {
  return createHash("sha256").update(body).digest("hex");
}
function document(path: string): KnowledgeDocument {
  const text = read(path);
  const end = text.indexOf(" -->\n");
  if (!text.startsWith(header) || end < 0)
    fail(
      "external_edit",
      "Knowledge metadata changed; review the source before importing it",
    );
  let metadata: Omit<KnowledgeDocument, "body">;
  try {
    metadata = JSON.parse(text.slice(header.length, end));
  } catch {
    return fail("external_edit", "Knowledge metadata is invalid");
  }
  const body = text.slice(end + 5);
  if (
    metadata.hash !== hash(body) ||
    !identifier.test(metadata.id) ||
    !Number.isSafeInteger(metadata.revision) ||
    metadata.revision < 1
  )
    fail(
      "external_edit",
      "Knowledge content changed outside its controlled revision",
    );
  return { ...metadata, body };
}
function encode(doc: KnowledgeDocument) {
  const { body, ...metadata } = doc;
  return `${header}${JSON.stringify(metadata)} -->\n${body}`;
}

/** Synchronous filesystem transaction under a process lock: no model runs here. */
export function knowledgeCommand(
  workspace: string,
  command: KnowledgeCommand,
): KnowledgeReply {
  safeID(command.vaultId);
  safeID(command.operationId);
  if (!Number.isSafeInteger(command.epoch) || command.epoch < 1)
    fail("invalid_epoch", "A positive epoch is required");
  const root = rootFolder(
    workspace,
    command.rootPath,
    command.action === "initialize",
  );
  return withLock(root, () => {
    const statePath = join(root, ".knowledge-root.json");
    let state: RootState;
    if (!existsSync(statePath)) {
      if (command.action !== "initialize")
        fail(
          "not_initialized",
          "Initialize the selected knowledge location first",
        );
      // Never adopt a populated folder or silently move a person's existing text.
      if (readdirSync(root).some((name) => name !== ".writer-lock"))
        fail("not_empty", "Choose an empty folder for a new knowledge root");
      state = {
        controlRevision: 1,
        vaultId: command.vaultId,
        epoch: command.epoch,
        state: command.staged ? "staged" : "active",
        operationId: command.operationId,
      };
      atomic(statePath, JSON.stringify(state));
    } else {
      try {
        state = JSON.parse(read(statePath));
      } catch (error) {
        if (error instanceof KnowledgeFileError) throw error;
        return fail("invalid_root", "Knowledge root metadata is invalid");
      }
    }
    if (state.vaultId !== command.vaultId || state.epoch !== command.epoch)
      fail("fenced", "The knowledge root owner or epoch changed");
    state.controlRevision ??= 1;
    const reply = (): KnowledgeReply => ({
      controlRevision: state.controlRevision,
      controlOperationId: state.operationId,
      vaultId: state.vaultId,
      epoch: state.epoch,
      state: state.state,
      operationId: command.operationId,
    });
    if (command.action === "initialize" || command.action === "status")
      return reply();
    if (["freeze", "activate", "retire"].includes(command.action)) {
      if (state.operationId === command.operationId) return reply();
      if (command.expectedControlRevision !== state.controlRevision)
        fail(
          "control_revision_conflict",
          "Knowledge root control changed; reconcile before retrying",
        );
      if (command.action === "freeze" && state.state === "active")
        state.state = "frozen";
      else if (
        command.action === "activate" &&
        (state.state === "staged" ||
          state.state === "frozen" ||
          state.state === "active")
      )
        state.state = "active";
      else if (
        command.action === "retire" &&
        (state.state === "frozen" || state.state === "staged")
      )
        state.state = "retired";
      else fail("invalid_state", "Knowledge root transition is not allowed");
      state.controlRevision++;
      state.operationId = command.operationId;
      atomic(statePath, JSON.stringify(state));
      return reply();
    }
    if (command.action === "list") {
      const names = readdirSync(root)
        .filter((name) => name.endsWith(".md"))
        .sort();
      if (names.length > 1000)
        fail("too_many", "Knowledge list needs a bounded migration page");
      return {
        ...reply(),
        // Listing transports metadata only; retrieve each body with read.
        documents: names.map((name) => ({
          ...document(join(root, name)),
          body: "",
        })),
      };
    }
    const id = safeID(command.documentId ?? "");
    const path = join(root, `${id}.md`);
    const raw = existsSync(path) ? read(path) : undefined;
    if (command.action === "inspect") {
      if (raw === undefined)
        fail("not_found", "Knowledge document does not exist");
      const end = raw.indexOf(" -->\n");
      return {
        ...reply(),
        review: {
          rawHash: hash(raw),
          rawContent: raw,
          body: raw.startsWith(header) && end >= 0 ? raw.slice(end + 5) : raw,
        },
      };
    }
    let previous: KnowledgeDocument | undefined;
    if (raw !== undefined) {
      try {
        previous = document(path);
      } catch (error) {
        if (
          !(error instanceof KnowledgeFileError) ||
          error.code !== "external_edit" ||
          !["adopt", "forget"].includes(command.action)
        )
          throw error;
        if (!command.expectedRawHash || hash(raw) !== command.expectedRawHash)
          fail(
            "external_edit",
            "Review the changed source before adopting or erasing it",
          );
      }
    }
    if (
      command.action === "adopt" &&
      previous?.operationId !== command.operationId
    ) {
      if (
        raw === undefined ||
        !command.expectedRawHash ||
        hash(raw) !== command.expectedRawHash
      )
        fail("revision_conflict", "The reviewed source changed again");
      if (previous?.deleted)
        fail("forgotten", "A forgotten identity cannot be adopted");
      if ((command.expectedRevision ?? 0) < 1)
        fail(
          "invalid_revision",
          "Adoption requires the indexed source revision",
        );
      previous = {
        id,
        revision: command.expectedRevision!,
        hash: command.expectedHash ?? "",
        body: "",
        operationId: "",
        deleted: false,
        sourceRef: "",
        updatedAt: "",
      };
    }
    if (
      !previous &&
      raw !== undefined &&
      ["adopt", "forget"].includes(command.action)
    ) {
      if (
        !Number.isSafeInteger(command.expectedRevision) ||
        (command.expectedRevision ?? 0) < (command.action === "forget" ? 0 : 1)
      )
        fail("invalid_revision", "An indexed source revision is required");
      previous = {
        id,
        revision: command.expectedRevision!,
        hash: command.expectedHash ?? "",
        body: "",
        operationId: "",
        deleted: false,
        sourceRef: "",
        updatedAt: "",
      };
    }
    if (
      !previous &&
      ["write", "import"].includes(command.action) &&
      readdirSync(root).filter((name) => name.endsWith(".md")).length >= 1000
    )
      fail(
        "capacity_reached",
        "This knowledge root holds at most 1000 identities, including revocation records",
      );
    if (previous && previous.id !== id)
      fail("external_edit", "Knowledge filename and identity disagree");
    if (command.action === "read") {
      if (!previous) fail("not_found", "Knowledge document does not exist");
      return { ...reply(), document: previous };
    }
    if (command.action === "import") {
      if (state.state !== "staged")
        fail("invalid_state", "Migration imports require a staged destination");
      const doc = command.importDocument;
      if (
        !doc ||
        doc.id !== id ||
        typeof doc.body !== "string" ||
        Buffer.byteLength(doc.body) > maxBytes ||
        !Number.isSafeInteger(doc.revision) ||
        doc.revision < 1 ||
        doc.hash !== hash(doc.body) ||
        typeof doc.sourceRef !== "string" ||
        Buffer.byteLength(doc.sourceRef) > 2000 ||
        Buffer.byteLength(doc.sourceVersion ?? "") > 1000 ||
        (doc.deleted && doc.body !== "") ||
        (!doc.deleted && !doc.sourceRef.trim())
      )
        fail("invalid_import", "Migration source revision is invalid");
      if (doc.expiresAt && !Number.isFinite(Date.parse(doc.expiresAt)))
        fail("invalid_expiry", "Migration source expiry is invalid");
      if (previous) {
        if (previous.deleted && !doc.deleted)
          fail("forgotten", "A migration cannot revive a forgotten identity");
        if (
          previous.hash === doc.hash &&
          previous.revision === doc.revision &&
          previous.deleted === doc.deleted &&
          previous.sourceRef === doc.sourceRef &&
          previous.sourceVersion === doc.sourceVersion &&
          previous.expiresAt === doc.expiresAt
        )
          return { ...reply(), document: previous };
        // Forgetting may race a copy; its later tombstone always wins.
        if (!doc.deleted || doc.revision < previous.revision)
          fail(
            "revision_conflict",
            "Staged source differs from the migration manifest",
          );
      }
      const imported = { ...doc, operationId: command.operationId };
      atomic(path, encode(imported));
      return { ...reply(), document: imported };
    }
    if (
      command.action !== "write" &&
      command.action !== "adopt" &&
      command.action !== "forget"
    )
      fail("invalid_action", "Unknown knowledge command");
    const body = command.action === "forget" ? "" : (command.body ?? "");
    if (
      Buffer.byteLength(body) > maxBytes ||
      Buffer.byteLength(command.sourceRef ?? "") > 2000 ||
      Buffer.byteLength(command.sourceVersion ?? "") > 1000
    )
      fail("too_large", "Knowledge document exceeds the size limit");
    if (
      (command.action === "write" || command.action === "adopt") &&
      (!body.trim() || !command.sourceRef?.trim())
    )
      fail("source_required", "Knowledge text needs an attributable source");
    if (command.expiresAt && !Number.isFinite(Date.parse(command.expiresAt)))
      fail("invalid_expiry", "Knowledge expiry must be a valid timestamp");
    if (previous?.operationId === command.operationId) {
      if (
        previous.hash !== hash(body) ||
        previous.deleted !== (command.action === "forget") ||
        previous.sourceRef !==
          (command.action === "forget" ? "" : command.sourceRef) ||
        previous.sourceVersion !==
          (command.action === "forget" ? undefined : command.sourceVersion) ||
        previous.expiresAt !==
          (command.action === "forget" ? undefined : command.expiresAt)
      )
        fail(
          "idempotency_conflict",
          "Operation identity was reused with different knowledge",
        );
      return { ...reply(), document: previous };
    }
    if (command.action !== "forget" && state.state !== "active")
      fail("frozen", "Knowledge root is not writable");
    if (previous?.deleted && command.action !== "forget")
      fail("forgotten", "A forgotten identity cannot be revived automatically");
    if (
      (previous?.revision ?? 0) !== command.expectedRevision ||
      (previous?.hash ?? "") !== (command.expectedHash ?? "")
    )
      fail(
        "revision_conflict",
        "Knowledge source changed; read its current revision first",
      );
    if (
      command.minimumRevision !== undefined &&
      (!Number.isSafeInteger(command.minimumRevision) ||
        command.minimumRevision < 0)
    )
      fail("invalid_revision", "Invalid minimum revision");
    const next: KnowledgeDocument = {
      id,
      revision:
        Math.max(
          previous?.revision ?? 0,
          command.action === "forget" ? (command.minimumRevision ?? 0) : 0,
        ) + 1,
      operationId: command.operationId,
      hash: hash(body),
      body,
      deleted: command.action === "forget",
      sourceRef: command.action === "forget" ? "" : (command.sourceRef ?? ""),
      sourceVersion:
        command.action === "forget" ? undefined : command.sourceVersion,
      expiresAt: command.action === "forget" ? undefined : command.expiresAt,
      updatedAt: new Date().toISOString(),
    };
    atomic(path, encode(next));
    return { ...reply(), document: next };
  });
}
