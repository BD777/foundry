import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  sep,
} from "node:path";
import type {
  ContextPatchCommand,
  ContextPatchReply,
} from "@bd777/foundry-protocol";
import { writeFileAtomic } from "../../platform/storage.js";

export class ContextPatchError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
function fail(code: string, message: string): never {
  throw new ContextPatchError(code, message);
}
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
export function contextPatchPathAllowed(value: string): boolean {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    /^[a-z]:/i.test(value)
  )
    return false;
  const parts = value.split("/");
  for (const part of parts) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[\x00-\x1f\x7f]/.test(part) ||
      [".foundry", ".git"].includes(part.toLowerCase())
    )
      return false;
  }
  const last = parts.at(-1)!;
  if (last === "AGENTS.md" || value === "README.md") return true;
  if (parts[0] === "docs" && parts.length >= 2 && last.endsWith(".md"))
    return true;
  for (const root of [".claude", ".agents"]) {
    if (
      parts.length === 4 &&
      parts[0] === root &&
      parts[1] === "skills" &&
      parts[3] === "SKILL.md"
    )
      return true;
    if (
      parts.length === 5 &&
      parts[0] === root &&
      parts[1] === "skills" &&
      parts[3] === "references" &&
      last.endsWith(".md")
    )
      return true;
  }
  return false;
}
function checkParents(base: string, target: string, create: boolean) {
  const parent = relative(base, dirname(target));
  if (
    parent === ".." ||
    parent.startsWith(`..${sep}`) ||
    isAbsolute(parent) ||
    /^[a-z]:/i.test(parent)
  )
    fail("invalid_request", "Context patch target leaves the workspace");
  let current = base;
  for (const part of parent ? parent.split(sep) : []) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (!missing(error)) throw error;
      if (!create) return;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST")
          throw mkdirError;
      }
      stat = lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail("unsafe_file", "Context patch parent must not follow links");
  }
}
function read(base: string, path: string): string | undefined {
  checkParents(base, path, false);
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 128 * 1024
    )
      fail("unsafe_file", "Expected a bounded regular file without aliases");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = readFileSync(fd);
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes))
        fail("invalid_encoding", "Context must be UTF-8");
      return text;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
function folder(path: string) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink())
    fail("unsafe_file", "Patch metadata must not follow links");
}
function atomic(path: string, body: string) {
  writeFileAtomic(path, body, {
    createParent: false,
    hardenParent: false,
    fsyncDirectory: true,
  });
}
function atomicCreate(path: string, body: string): boolean {
  const parent = dirname(path);
  const temp = join(
    parent,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    fd = openSync(parent, "r");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}
type Receipt = {
  requestHash: string;
  state: "prepared" | "applied" | "conflict";
  before: string | null;
  afterHash: string;
  path: string;
};
/** Synchronous CAS critical section. The Server fences new Foundry inputs until
 * this receipt settles. Unmanaged OS writers retain their existing rights. */
export function contextPatch(
  workspace: string,
  cmd: ContextPatchCommand,
): ContextPatchReply {
  if (
    !contextPatchPathAllowed(cmd.path) ||
    !/^[-a-zA-Z0-9_]{1,160}$/.test(cmd.operationId)
  )
    fail("invalid_request", "Invalid context patch target");
  const base = realpathSync(workspace);
  const target = join(base, cmd.path);
  const current = () => {
    const content = read(base, target);
    return { content, hash: content === undefined ? "missing" : hash(content) };
  };
  if (cmd.action === "read") {
    const c = current();
    return {
      operationId: cmd.operationId,
      path: cmd.path,
      hash: c.hash,
      content: c.content ?? "",
      state: "read",
    };
  }
  const baseHash = cmd.baseHash === "" ? "missing" : cmd.baseHash;
  if (
    cmd.action !== "apply" ||
    !cmd.content ||
    Buffer.byteLength(cmd.content, "utf8") > 32768 ||
    !(baseHash === "missing" || /^[a-f0-9]{64}$/.test(baseHash))
  )
    fail("invalid_request", "Invalid context patch");
  const root = join(base, ".foundry");
  folder(root);
  const dir = join(root, "context-patches");
  folder(dir);
  const file = join(dir, `${cmd.operationId}.json`);
  const requestHash = hash(JSON.stringify([cmd.path, baseHash, cmd.content]));
  const afterHash = hash(cmd.content);
  const old = read(base, file);
  let receipt: Receipt;
  if (old !== undefined) {
    receipt = JSON.parse(old) as Receipt;
    if (receipt.requestHash !== requestHash)
      fail("idempotency_conflict", "Operation already describes another patch");
  } else {
    const c = current();
    receipt = {
      requestHash,
      state: c.hash === baseHash ? "prepared" : "conflict",
      before: c.content ?? null,
      afterHash,
      path: cmd.path,
    };
    atomic(file, JSON.stringify(receipt));
  }
  if (receipt.state === "prepared") {
    const c = current();
    if (c.hash === afterHash) {
      receipt.state = "applied";
    } else if (c.hash !== baseHash) {
      receipt.state = "conflict";
    } else {
      checkParents(base, target, true);
      if (baseHash === "missing") {
        receipt.state = atomicCreate(target, cmd.content)
          ? "applied"
          : "conflict";
      } else {
        atomic(target, cmd.content);
        receipt.state = "applied";
      }
    }
    atomic(file, JSON.stringify(receipt));
  }
  return {
    operationId: cmd.operationId,
    path: cmd.path,
    hash: receipt.state === "applied" ? afterHash : current().hash,
    state: receipt.state,
  };
}
