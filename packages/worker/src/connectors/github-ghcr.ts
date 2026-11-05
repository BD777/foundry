import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { foundryStatePath } from "../platform/state-root.js";

export const ghcrHelperName = "docker-credential-foundry-ghcr";
export function ghcrDirectory(): string {
  return foundryStatePath("connectors", "github-ghcr");
}
export function ghcrEnabled(): boolean {
  try {
    const config = JSON.parse(
      readFileSync(join(ghcrDirectory(), "config.json"), "utf8"),
    );
    return config.credHelpers?.["ghcr.io"] === "foundry-ghcr";
  } catch {
    return false;
  }
}
export function enableGhcr(): void {
  mkdirSync(ghcrDirectory(), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(ghcrDirectory(), "config.json"),
    JSON.stringify({ credHelpers: { "ghcr.io": "foundry-ghcr" } }),
    { mode: 0o600 },
  );
}
// Rewritten when a session is prepared, so an update never leaves a helper
// pointing at a runtime that has been retired. No token goes into the script.
export function ghcrSessionTools(gh: string): Record<string, string> {
  if (!ghcrEnabled()) return {};
  const path = join(ghcrDirectory(), ghcrHelperName);
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const script = fileURLToPath(
    new URL("./github-ghcr-helper.js", import.meta.url),
  );
  writeFileSync(
    path,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${quote(gh)} "$@"\n`,
    { mode: 0o700 },
  );
  return { [ghcrHelperName]: path };
}
