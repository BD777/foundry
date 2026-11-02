import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { foundryStatePath } from "./state-root.js";

// Shared by the daemon and execution hosts. A crashed host's reservation stays
// denied (safe false positive); a process never removes another one's marker.
export function protectHTTPPort(port: number): () => void {
  const directory = foundryStatePath("protected-http-ports");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = foundryStatePath("protected-http-ports", String(port));
  const marker = randomUUID();
  writeFileSync(path, marker, { mode: 0o600 });
  return () => {
    try {
      if (readFileSync(path, "utf8") === marker) rmSync(path);
    } catch {
      /* retain a denial on uncertainty */
    }
  };
}
export function isProtectedHTTPPort(port: number): boolean {
  return existsSync(foundryStatePath("protected-http-ports", String(port)));
}
