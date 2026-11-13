import {
  enableGhcr,
  ghcrDirectory,
  ghcrEnabled,
  ghcrSessionTools,
} from "./github-ghcr.js";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  ConnectorAuthorizationGroup,
  ConnectorAuthorizationScope,
} from "@bd777/foundry-protocol";
import type {
  DeviceHeldAdapter,
  LoginReading,
  SignInStep,
  ToolResult,
  ToolRun,
} from "./device-held.js";
import { ForeignToolError } from "./device-held.js";
import { findOnPath, mergeEnvironment } from "./session-environment.js";
import { installGitHubCli } from "./gh-install.js";
import { foundryStatePath } from "../platform/state-root.js";
import { redactSecrets } from "../platform/secret-redaction.js";

/**
 * GitHub CLI (`gh`), device-held: the login is gh's own, kept on the device
 * (its keyring or hosts.yml) and never read by Foundry; only the account
 * name crosses. Signing in runs gh's device-code login for github.com and
 * nothing more: the person's global git configuration is never written. A
 * session that may use the login gets `gh` on its PATH (the generic runtime,
 * device-held.ts) and, from sessionEnvironment, git's credential helper for
 * github.com in its own environment only, so git over HTTPS to GitHub
 * (cloning a private repository) uses the same login there. Sessions that
 * may not use it get an empty gh configuration.
 */

const host = "github.com";

/**
 * GH_TOKEN of a session that may not use the login. gh reads the keychain
 * whenever it has no token from the environment or its configuration, even
 * with an empty GH_CONFIG_DIR (gh 2.40+ falls back to the unkeyed
 * `gh:<host>` item), so an empty value would not keep it out.
 */
export const isolatedGhToken = "foundry-no-access";

/**
 * GitHub permissions are the classic OAuth scopes of gh's token. The list
 * a person chooses from is the catalog's `permissions` group, taken from
 * GitHub's own list for github.com: docs.github.com/en/apps/oauth-apps/
 * building-oauth-apps/scopes-for-oauth-apps (source github/docs
 * content/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps.md, the
 * fpt entries; `site_admin` and the enterprise scopes are GHES/GHEC only).
 * Deliberately not offered: `offline_access`. gh's OAuth app issues
 * tokens that do not expire and gh never refreshes one, so asking for an
 * expiring token would leave gh signed out after eight hours.
 *
 * gh owns the minimum (`repo`, `read:org`, `gist`; `gh auth login --help`)
 * and asks for it on every sign-in and refresh, so those stay required.
 */
const minimumScopes = ["repo", "read:org", "gist"];
const permissionsGroup = "permissions";
const fallbackScopes: ConnectorAuthorizationScope[] = [
  // An older Server's catalog has no permissions group: still read the
  // packages capability. GitHub's token settings nest read:packages under
  // write:packages and normalize it away (DEV-130).
  { id: "read:packages", label: "", impliedBy: ["write:packages"] },
  { id: "write:packages", label: "" },
  { id: "delete:packages", label: "" },
];

/** The token's scopes as `gh auth status` prints them; undefined when it says none. */
export function parseGhTokenScopes(result: ToolResult): string[] | undefined {
  const line = /Token scopes:\s*([^\r\n]*)/i.exec(
    `${result.stdout}\n${result.stderr}`,
  )?.[1];
  if (line === undefined) return undefined;
  return line
    .replace(/['"]/g, "")
    .split(/[,\s]+/)
    .filter((scope) => scope && scope !== "none");
}

/**
 * The listed scopes the token holds: named outright, or included in a
 * broader scope it holds (GitHub reports only the broadest of a family).
 */
export function grantedScopes(
  raw: string[],
  listed: ConnectorAuthorizationScope[],
): string[] {
  const held = new Set(raw);
  return listed
    .filter(
      (scope) =>
        held.has(scope.id) ||
        (scope.impliedBy ?? []).some((parent) => held.has(parent)),
    )
    .map((scope) => scope.id);
}

/** What `gh auth refresh` must add and remove to hold exactly `wanted`. */
export function scopeChange(
  wanted: string[],
  raw: string[],
  listed: ConnectorAuthorizationScope[],
): { add: string[]; remove: string[] } {
  const granted = grantedScopes(raw, listed);
  const add = wanted.filter((scope) => !granted.includes(scope));
  // Only a scope the token names outright can be dropped; a child of a
  // broader scope goes with its parent.
  const remove = raw.filter(
    (scope) =>
      listed.some((entry) => entry.id === scope) &&
      !wanted.includes(scope) &&
      !minimumScopes.includes(scope),
  );
  return { add, remove };
}

function listedScopes(
  groups: ConnectorAuthorizationGroup[] | undefined,
): ConnectorAuthorizationScope[] {
  return (
    groups?.find((group) => group.id === permissionsGroup)?.scopes ??
    fallbackScopes
  );
}

/** A choice of scopes from the page, checked against the listed ones. */
function chosenScopes(
  option: string | undefined,
  listed: ConnectorAuthorizationScope[],
): string[] {
  const chosen = [
    ...new Set((option ?? "").split(",").map((scope) => scope.trim())),
  ].filter(Boolean);
  if (chosen.some((scope) => !listed.some((entry) => entry.id === scope)))
    throw new Error("Unsupported GitHub scopes.");
  return [...new Set([...minimumScopes, ...chosen])];
}

/** gh auth status, in the words of gh 2.x (old "as", new "account"). */
export function parseGhAuthStatus(result: ToolResult): LoginReading {
  const text = `${result.stdout}\n${result.stderr}`;
  const account =
    /Logged in to github\.com (?:account|as) ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/.exec(
      text,
    )?.[1];
  if (result.code === 0 && account)
    return { signedIn: true, identity: account };
  if (
    /not logged in|not logged into|no accounts|Failed to log in|token .* (?:is )?invalid|authentication failed/i.test(
      text,
    ) ||
    result.code !== 0
  )
    return { signedIn: false };
  throw new Error("GitHub CLI did not say who is signed in.");
}

/** The code and page of a running `gh auth login --web`. */
export function parseGhDeviceCode(
  output: string,
): { code: string; url: string } | undefined {
  // gh 2.103.3 put the code in parentheses and says it copied it to the
  // clipboard; older versions asked the person to copy it after a colon.
  const code = /one-time code(?::|\s*\()\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/i
    .exec(output)?.[1]
    ?.toUpperCase();
  const url = /(https:\/\/github\.com\/login\/device)\b/.exec(output)?.[1];
  if (code && url) return { code, url };
  if (!url) return undefined;

  // Keep sign-in working through future wording changes, but only when the
  // output has one unmistakable device code. Numeric date/version shapes are
  // excluded, and a second candidate makes the guess ambiguous.
  const candidates = [
    ...output.matchAll(/(?<![A-Z0-9])[A-Z0-9]{4}-[A-Z0-9]{4}(?![A-Z0-9])/gi),
  ]
    .map((match) => match[0].toUpperCase())
    .filter((candidate) => !/^\d{4}-\d{4}$/.test(candidate));
  const [candidate] = candidates;
  return candidates.length === 1 && candidate
    ? { code: candidate, url }
    : undefined;
}

const waitForCodeMs = 30_000;
const signInLifetimeMs = 15 * 60_000;

/** A timeout error with the useful, sanitized tail of gh's output. */
export function ghDeviceCodeTimeout(output: string): string {
  const tail = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .map((line) => redactSecrets(line))
    .join(" | ")
    .replace(/(?<![A-Z0-9])[A-Z0-9]{4}-[A-Z0-9]{4}(?![A-Z0-9])/gi, "[REDACTED]")
    .slice(-230);
  return `GitHub CLI did not show a sign-in code in time.${tail ? ` Last output: ${tail}` : ""}`.slice(
    0,
    300,
  );
}

/** The one GitHub sign-in running on this device, if any. */
class GhSignIn {
  private child: ChildProcess | undefined;
  private output = "";
  private exit: number | null | undefined;
  private expiry: NodeJS.Timeout | undefined;

  /**
   * Signs in (`gh auth login`, asking for `scopes` on top of gh's
   * minimum), or with `change` refreshes the active login's token to add
   * and remove scopes (`gh auth refresh`); gh keeps the token either way.
   */
  async begin(
    run: ToolRun,
    request: {
      scopes?: string[];
      change?: { add: string[]; remove: string[] };
    } = {},
  ): Promise<SignInStep> {
    this.cancel();
    if (!run.spawn) throw new Error("This worker cannot run GitHub sign-in.");
    const { scopes, change } = request;
    const extra = scopes?.filter((scope) => !minimumScopes.includes(scope));
    const child = run.spawn(
      change
        ? [
            "auth",
            "refresh",
            "--hostname",
            host,
            ...(change.add.length ? ["--scopes", change.add.join(",")] : []),
            ...(change.remove.length
              ? ["--remove-scopes", change.remove.join(",")]
              : []),
          ]
        : [
            "auth",
            "login",
            "--hostname",
            host,
            "--git-protocol",
            "https",
            "--web",
            "--skip-ssh-key",
            ...(extra?.length ? ["--scopes", extra.join(",")] : []),
          ],
    );
    this.child = child;
    this.output = "";
    this.exit = undefined;
    // A cancelled sign-in's process can still report after the next began.
    const current = () => this.child === child;
    const take = (chunk: Buffer) => {
      if (current())
        this.output = (this.output + chunk.toString()).slice(-64 * 1024);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (error) => {
      if (!current()) return;
      this.output += `\n${error.message}`;
      this.exit = -1;
    });
    child.on("exit", (code) => {
      if (current()) this.exit = code ?? -1;
    });
    this.expiry = setTimeout(() => this.cancel(), signInLifetimeMs);
    this.expiry.unref?.();
    const started = Date.now();
    for (;;) {
      const found = parseGhDeviceCode(this.output);
      if (found)
        return {
          status: "pending",
          verificationUrl: found.url,
          userCode: found.code,
        };
      if (this.exit !== undefined)
        return { status: "failed", error: failure(this.output) };
      if (Date.now() - started > waitForCodeMs) {
        this.cancel();
        return {
          status: "failed",
          error: ghDeviceCodeTimeout(this.output),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  poll(): SignInStep {
    if (!this.child) return { status: "expired" };
    if (this.exit === undefined) return { status: "pending" };
    const output = this.output;
    const exit = this.exit;
    this.finish();
    if (exit !== 0)
      return /denied|access_denied/i.test(output)
        ? { status: "denied", error: failure(output) }
        : /expired/i.test(output)
          ? { status: "expired", error: failure(output) }
          : { status: "failed", error: failure(output) };
    return { status: "complete" };
  }

  cancel(): void {
    if (this.child && this.exit === undefined) {
      const pid = this.child.pid;
      try {
        if (pid) process.kill(-pid, "SIGTERM");
        else this.child.kill("SIGTERM");
      } catch {
        this.child.kill("SIGTERM");
      }
    }
    this.finish();
  }

  private finish(): void {
    clearTimeout(this.expiry);
    this.child = undefined;
  }
}

/** The last line gh wrote, without a code or token in it. */
function failure(output: string): string {
  const line =
    output
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry && !/one-time code|Open this URL/i.test(entry))
      .at(-1) ?? "";
  return redactSecrets(line || "GitHub CLI could not sign in.").slice(0, 300);
}

const signIn = new GhSignIn();

/** The gh auth subcommands that change the device's login. */
export const loginChanges = [
  "login",
  "logout",
  "refresh",
  "switch",
  "setup-git",
];

/**
 * The `gh` a session runs: the device's gh, except for the subcommands
 * that change its login or the person's git configuration. Those are the
 * person's, in Connectors (DEV-136): a session that ran `gh auth refresh`
 * itself widened the device login outside Foundry. This keeps an agent
 * from doing so by mistake; it is not a wall against a process that calls
 * the real gh directly.
 */
export function sessionGh(gh: string): string {
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const dir = foundryStatePath("connectors", "github");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "gh-session");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      "# Foundry: this session uses the device's GitHub login as it is.",
      'if [ "$1" = auth ]; then',
      '  case "$2" in',
      `    ${loginChanges.join("|")})`,
      '      echo "gh auth $2 is not available in a Foundry session: the device\'s GitHub login is changed by the person in Foundry. Ask them to open Connectors > GitHub CLI > this device > GitHub permissions and add the scope GitHub asked for (for example workflow), then continue in a new turn." >&2',
      "      exit 4 ;;",
      "  esac",
      "fi",
      `exec ${quote(gh)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return path;
}

/** gh auth status for github.com; gh before 2.40 has no --active. */
async function authStatus(run: ToolRun): Promise<ToolResult> {
  const args = ["auth", "status", "--hostname", host];
  const active = await run([...args, "--active"], { timeoutMs: 20_000 });
  if (/unknown flag: --active/.test(active.stderr + active.stdout))
    return run(args, { timeoutMs: 20_000 });
  return active;
}

export const githubAdapter: DeviceHeldAdapter = {
  name: "github",
  clearEnvironment: [],
  runEnvironment: {
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_SPINNER_DISABLED: "1",
    NO_COLOR: "1",
    // The login page opens in the person's own browser, not the device's.
    GH_BROWSER: "true",
    BROWSER: "true",
  },
  async readVersion(run) {
    const result = await run(["--version"]);
    const version = /gh version (\d+\.\d+\.\d+)/.exec(result.stdout)?.[1];
    if (result.code === 0 && version) return version;
    // GitHub CLI names its releases page; a same-named tool (a company's
    // host lookup `gh`, say) answers without mentioning GitHub at all.
    const output = `${result.stdout}\n${result.stderr}`;
    if (output.trim() && !/github/i.test(output))
      throw new ForeignToolError(
        "The gh on this device is another program, not GitHub CLI.",
      );
    throw new Error("Could not read the GitHub CLI version.");
  },
  async readLogin(run) {
    return parseGhAuthStatus(await authStatus(run));
  },
  async readAuthorizations(run, _version, groups) {
    const result = await authStatus(run);
    const login = parseGhAuthStatus(result);
    const listed = listedScopes(groups);
    const raw = login.signedIn ? parseGhTokenScopes(result) : undefined;
    const granted = raw ? grantedScopes(raw, listed) : undefined;
    const packages = granted?.includes("read:packages");
    const checkedAt = new Date().toISOString();
    const status = (ready: boolean | undefined) =>
      !login.signedIn
        ? "needs_auth"
        : ready === undefined
          ? "unknown"
          : ready
            ? "ready"
            : "needs_auth";
    return [
      {
        id: permissionsGroup,
        revision: 1,
        // A token gh cannot list scopes for (GH_TOKEN, a fine-grained
        // token) is not claimed to hold any.
        status: status(granted ? true : undefined),
        grantedScopes: granted,
        verification: granted ? "local_state" : "not_checked",
        checkedAt,
      },
      {
        id: "packages-read",
        revision: 1,
        status: status(granted ? packages : undefined),
        grantedScopes: granted?.filter((scope) => scope.endsWith(":packages")),
        verification: granted ? "local_state" : "not_checked",
        checkedAt,
      },
      {
        id: "ghcr-docker",
        revision: 1,
        status:
          login.signedIn && packages && ghcrEnabled() ? "ready" : "needs_auth",
        verification: "local_state",
        checkedAt,
      },
    ];
  },
  async beginAuthorization(run, _scratch, group, options) {
    if (
      ![permissionsGroup, "packages-read", "ghcr-docker"].includes(group.id) ||
      group.revision !== 1
    )
      throw new Error("Unsupported GitHub authorization.");
    const result = await authStatus(run);
    const login = parseGhAuthStatus(result);
    if (!login.signedIn)
      return {
        step: {
          status: "failed",
          error: "Sign in to GitHub on this device first.",
        },
      };
    const raw = parseGhTokenScopes(result);
    if (group.id === "ghcr-docker") {
      if (
        !raw?.length ||
        !grantedScopes(raw, fallbackScopes).includes("read:packages")
      )
        return {
          step: {
            status: "failed",
            error:
              "Authorize package reading first, then enable GHCR for Docker.",
          },
        };
      enableGhcr();
      return { step: { status: "complete" } };
    }
    if (!raw)
      return {
        step: {
          status: "failed",
          error:
            "GitHub CLI does not report this login's scopes (a token from the environment or a fine-grained token). Sign in with gh's own login to choose permissions.",
        },
      };
    // packages-read (DEV-130): its own button adds read:packages. The
    // permissions group sends the whole wanted set, so unchecking removes.
    const listed =
      group.id === permissionsGroup ? (group.scopes ?? []) : fallbackScopes;
    let wanted: string[];
    let change: { add: string[]; remove: string[] };
    if (group.id === permissionsGroup) {
      wanted = chosenScopes(options?.scopes, listed);
      change = scopeChange(wanted, raw, listed);
    } else {
      wanted = (options?.scopes ?? "read:packages").split(",").filter(Boolean);
      if (
        !wanted.includes("read:packages") ||
        wanted.some((scope) => !listed.some((entry) => entry.id === scope))
      )
        throw new Error("Unsupported GitHub package scopes.");
      const granted = grantedScopes(raw, listed);
      change = {
        add: wanted.filter((scope) => !granted.includes(scope)),
        remove: [],
      };
    }
    if (!change.add.length && !change.remove.length)
      return { step: { status: "complete" } };
    return {
      step: await signIn.begin(run, { change }),
      continuation: {
        identity: login.identity,
        wanted,
        listed: listed.map((s) => s.id),
      },
    };
  },
  async pollAuthorization(run, group, continuation) {
    const expected = continuation as {
      identity: string;
      wanted: string[];
      listed: string[];
    };
    const step = signIn.poll();
    if (step.status !== "complete") return step;
    const result = await authStatus(run);
    const login = parseGhAuthStatus(result);
    if (!login.signedIn || login.identity !== expected.identity)
      return {
        status: "failed",
        error:
          "The active GitHub account changed. Check the device login before continuing.",
      };
    const listed =
      group.id === permissionsGroup ? (group.scopes ?? []) : fallbackScopes;
    const granted = grantedScopes(parseGhTokenScopes(result) ?? [], listed);
    if (!expected.wanted.every((scope) => granted.includes(scope)))
      return {
        status: "failed",
        error:
          "GitHub did not grant every selected permission. Check the connector before retrying.",
      };
    return step;
  },
  async install(managedBin, progress) {
    await installGitHubCli({ managedBin, progress });
  },
  async beginSignIn(run, _scratch, options) {
    // The sign-in method lets the person choose from the permissions
    // group (scopesGroup); the Runtime passes the catalog's group along.
    return signIn.begin(run, {
      scopes: options?.scopes
        ? options.scopes
            .split(",")
            .map((scope) => scope.trim())
            .filter(Boolean)
        : undefined,
    });
  },
  async pollSignIn() {
    return signIn.poll();
  },
  cancelSignIn() {
    signIn.cancel();
  },
  async signOut(run) {
    const login = parseGhAuthStatus(await authStatus(run));
    if (!login.signedIn || !login.identity) return;
    const logout = ["auth", "logout", "--hostname", host];
    let result = await run([...logout, "--user", login.identity]);
    // gh before 2.40 has one account per host and no --user.
    if (/unknown flag: --user/.test(result.stderr + result.stdout))
      result = await run(logout);
    if (result.code !== 0)
      throw new Error(
        `GitHub CLI could not sign out: ${failure(result.stderr || result.stdout)}`,
      );
  },
  sessionTools(located) {
    return { ...ghcrSessionTools(located.path), gh: sessionGh(located.path) };
  },
  sessionEnvironment(located) {
    // git's credential helper for github.com, set for the session's
    // processes only (git reads GIT_CONFIG_COUNT/KEY_n/VALUE_n like config
    // entries); the person's own git configuration stays as it is.
    return {
      ...(ghcrEnabled() ? { DOCKER_CONFIG: ghcrDirectory() } : {}),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `credential.https://${host}.helper`,
      GIT_CONFIG_VALUE_0: `!${JSON.stringify(located.path)} auth git-credential`,
    };
  },
  async sessionCheck(shape, environment, located) {
    const git = findOnPath("git", environment.PATH);
    if (!git)
      return shape === "usable"
        ? "git is not on the PATH a session gets"
        : undefined;
    if (shape === "usable") {
      // Only the configuration of the session's environment answers: not
      // the person's global git configuration, and nothing is asked on a
      // terminal.
      const obtained = await gitYieldsCredential(git, {
        ...environment,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "true",
      });
      return obtained
        ? undefined
        : `git gets no ${host} credential from the gh login in a session's environment`;
    }
    // gh itself first: without a configuration of its own it still falls
    // back to the token in the keychain.
    if (await ghHandsOutToken(located.path, environment))
      return `gh still hands out a ${host} token under the isolation environment`;
    // Then git as the session runs it: the person's global and system
    // configuration included (osxkeychain, a `gh auth setup-git` helper),
    // and gh's helper set ahead of the isolation as if it were global.
    // Nothing is asked on a terminal.
    const obtained = await gitYieldsCredential(
      git,
      mergeEnvironment(
        githubAdapter.sessionEnvironment!(located),
        mergeEnvironment(environment, {
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "true",
          SSH_ASKPASS: "true",
        }),
      ),
    );
    return obtained
      ? `git's credential helpers still hand out a ${host} credential under the isolation environment`
      : undefined;
  },
  isolationEnvironment() {
    // An empty configuration folder gh cannot write: gh, and git through
    // gh's credential helper, find no login in it, and a `gh auth login`
    // in one such session cannot leave one for the others. Whatever a
    // session left there anyway is removed before the next one starts.
    const empty = foundryStatePath("isolation", "gh");
    mkdirSync(empty, { recursive: true, mode: 0o700 });
    chmodSync(empty, 0o700);
    for (const entry of readdirSync(empty))
      rmSync(join(empty, entry), { recursive: true, force: true });
    chmodSync(empty, 0o500);
    return {
      DOCKER_CONFIG: join(empty),
      GH_CONFIG_DIR: join(empty),
      // gh has no switch to leave the keychain alone: a token in GH_TOKEN
      // is the one it uses instead, and this one GitHub refuses.
      GH_TOKEN: isolatedGhToken,
      GITHUB_TOKEN: "",
      GH_ENTERPRISE_TOKEN: "",
      GITHUB_ENTERPRISE_TOKEN: "",
      // An empty helper empties the list git collected for github.com so
      // far (system osxkeychain, a global `gh auth setup-git`); the
      // session's environment is read last.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `credential.https://${host}.helper`,
      GIT_CONFIG_VALUE_0: "",
    };
  },
};

/**
 * Whether `gh auth token` hands out a token other than the isolation's
 * placeholder. Only that fact leaves this function.
 */
function ghHandsOutToken(
  gh: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(gh, ["auth", "token", "--hostname", host], {
      env: {
        ...environment,
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let answer = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (answer.length < 16 * 1024) answer += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const token = answer.trim();
      resolve(code === 0 && token !== "" && token !== isolatedGhToken);
    });
  });
}

/**
 * Whether `git credential fill` for github.com yields a password. Only that
 * fact leaves this function: the answer is read here and dropped.
 */
function gitYieldsCredential(
  git: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(git, ["credential", "fill"], {
      env: environment,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let answer = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (answer.length < 16 * 1024) answer += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && /^password=.+$/m.test(answer));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(`protocol=https\nhost=${host}\n\n`);
  });
}
