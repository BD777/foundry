import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
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
function read(path: string): string | undefined {
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
    !["AGENTS.md", "README.md"].includes(cmd.path) ||
    !/^[-a-zA-Z0-9_]{1,160}$/.test(cmd.operationId)
  )
    fail("invalid_request", "Invalid context patch target");
  const base = realpathSync(workspace);
  const target = join(base, cmd.path);
  const current = () => {
    const content = read(target);
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
  if (
    cmd.action !== "apply" ||
    !cmd.content ||
    Buffer.byteLength(cmd.content, "utf8") > 32768 ||
    !(cmd.baseHash === "missing" || /^[a-f0-9]{64}$/.test(cmd.baseHash))
  )
    fail("invalid_request", "Invalid context patch");
  const root = join(base, ".foundry");
  folder(root);
  const dir = join(root, "context-patches");
  folder(dir);
  const file = join(dir, `${cmd.operationId}.json`);
  const requestHash = hash(
    JSON.stringify([cmd.path, cmd.baseHash, cmd.content]),
  );
  const afterHash = hash(cmd.content);
  const old = read(file);
  let receipt: Receipt;
  if (old !== undefined) {
    receipt = JSON.parse(old) as Receipt;
    if (receipt.requestHash !== requestHash)
      fail("idempotency_conflict", "Operation already describes another patch");
  } else {
    const c = current();
    receipt = {
      requestHash,
      state: c.hash === cmd.baseHash ? "prepared" : "conflict",
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
    } else if (c.hash !== cmd.baseHash) {
      receipt.state = "conflict";
    } else {
      atomic(target, cmd.content);
      receipt.state = "applied";
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
