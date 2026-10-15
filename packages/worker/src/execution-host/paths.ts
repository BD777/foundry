import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { foundryStatePath } from "../state-root.js";
export function executionHostPaths() {
  const root = foundryStatePath("execution-host");
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return {
    root,
    socket: resolve(root, "control.sock"),
    token: resolve(root, "token"),
    unit: `foundry-execution-${key}.service`,
  };
}
