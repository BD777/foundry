import { spawnSync } from "node:child_process";
import { delimiter } from "node:path";
import { isSessionPathEntry } from "../platform/path-list.js";

/**
 * The PATH the person's login shell builds (~/.local/bin, nvm, paths a
 * company profile adds): the service's own PATH is minimal. Read once and
 * kept; a shell that fails or hangs leaves the service PATH in use.
 */

const marker = "__FOUNDRY_LOGIN_PATH__";
const timeoutMs = 5000;

export interface LoginPathOptions {
  shell?: string;
  run?: typeof spawnSync;
  log?: (message: string) => void;
}

export function readLoginShellPath(
  options: LoginPathOptions = {},
): string | undefined {
  const shell =
    options.shell ??
    process.env.SHELL ??
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const log = options.log ?? ((message) => console.warn(message));
  const result = (options.run ?? spawnSync)(
    shell,
    ["-lc", `printf '${marker}%s${marker}' "$PATH"`],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const found = result.error
    ? undefined
    : new RegExp(`${marker}(.*)${marker}`, "s").exec(
        String(result.stdout),
      )?.[1];
  if (!found) {
    log(
      `Could not read the login shell PATH from ${shell} (${result.error?.message ?? `exit ${result.status}`}); sessions use the service PATH.`,
    );
    return undefined;
  }
  return found
    .split(delimiter)
    .filter((entry) => entry && !isSessionPathEntry(entry))
    .join(delimiter);
}

let cached: { value: string | undefined } | undefined;
let reader: () => string | undefined = () => readLoginShellPath();

/** The login shell's PATH, read on first use. */
export function loginShellPath(): string | undefined {
  cached ??= { value: reader() };
  return cached.value;
}

/** Tests: replaces the login shell reader and forgets the cached value. */
export function setLoginShellPathReaderForTests(
  next: (() => string | undefined) | undefined,
): void {
  reader = next ?? (() => readLoginShellPath());
  cached = undefined;
}
