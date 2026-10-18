import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { foundryStatePath } from "../state-root.js";
export function executionHostPaths(root = foundryStatePath("execution-host")) {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const label = `app.foundry.execution.${key}`;
  const socketRoot =
    process.platform === "darwin" &&
    Buffer.byteLength(resolve(root, "control.sock")) > 100
      ? `/tmp/foundry-exec-${process.getuid?.() ?? "user"}-${key}`
      : root;
  return {
    root,
    socketRoot,
    socket: resolve(socketRoot, "control.sock"),
    token: resolve(root, "token"),
    unit: `foundry-execution-${key}.service`,
    label,
    plist: resolve(homedir(), "Library", "LaunchAgents", `${label}.plist`),
  };
}
