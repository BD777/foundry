import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  DeviceHeldAdapter,
  LoginReading,
  SignInStep,
  ToolResult,
  ToolRun,
} from "./device-held.js";
import { installGitHubCli } from "./gh-install.js";
import { foundryStatePath } from "../platform/state-root.js";

/**
 * GitHub CLI (`gh`), device-held: the login is gh's own, kept on the device
 * (its keyring or hosts.yml) and never read by Foundry; only the account
 * name crosses. Signing in runs gh's device-code login for github.com and
 * then `gh auth setup-git`, so git over HTTPS to GitHub (cloning, and
 * installing connector extensions from private repositories) uses the same
 * login. Sessions that may not use it get an empty gh configuration.
 */

const host = "github.com";

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
  const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output)?.[1];
  const url = /(https:\/\/github\.com\/login\/device)\b/.exec(output)?.[1];
  return code && url ? { code, url } : undefined;
}

const waitForCodeMs = 30_000;
const signInLifetimeMs = 15 * 60_000;

/** The one GitHub sign-in running on this device, if any. */
class GhSignIn {
  private child: ChildProcess | undefined;
  private output = "";
  private exit: number | null | undefined;
  private expiry: NodeJS.Timeout | undefined;
  private run: ToolRun | undefined;

  async begin(run: ToolRun): Promise<SignInStep> {
    this.cancel();
    if (!run.spawn) throw new Error("This worker cannot run GitHub sign-in.");
    const child = run.spawn([
      "auth",
      "login",
      "--hostname",
      host,
      "--git-protocol",
      "https",
      "--web",
      "--skip-ssh-key",
    ]);
    this.child = child;
    this.run = run;
    this.output = "";
    this.exit = undefined;
    const take = (chunk: Buffer) => {
      this.output = (this.output + chunk.toString()).slice(-64 * 1024);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (error) => {
      this.output += `\n${error.message}`;
      this.exit = -1;
    });
    child.on("exit", (code) => {
      this.exit = code ?? -1;
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
          error: "GitHub CLI did not show a sign-in code in time.",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async poll(): Promise<SignInStep> {
    if (!this.child) return { status: "expired" };
    if (this.exit === undefined) return { status: "pending" };
    const output = this.output;
    const exit = this.exit;
    const run = this.run;
    this.finish();
    if (exit !== 0)
      return /denied|access_denied/i.test(output)
        ? { status: "denied", error: failure(output) }
        : /expired/i.test(output)
          ? { status: "expired", error: failure(output) }
          : { status: "failed", error: failure(output) };
    // git over HTTPS to GitHub uses this login from now on.
    if (run) await run(["auth", "setup-git", "--hostname", host]);
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
    this.run = undefined;
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
  return (line || "GitHub CLI could not sign in.")
    .replace(/gh[opsu]_[A-Za-z0-9]{20,}/g, "…")
    .slice(0, 300);
}

const signIn = new GhSignIn();

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
    if (result.code !== 0 || !version)
      throw new Error("Could not read the GitHub CLI version.");
    return version;
  },
  async readLogin(run) {
    return parseGhAuthStatus(await authStatus(run));
  },
  async install(managedBin, progress) {
    await installGitHubCli({ managedBin, progress });
  },
  beginSignIn(run) {
    return signIn.begin(run);
  },
  pollSignIn() {
    return signIn.poll();
  },
  cancelSignIn() {
    signIn.cancel();
  },
  async signOut(run) {
    const login = parseGhAuthStatus(await authStatus(run));
    if (!login.signedIn || !login.identity) return;
    const result = await run([
      "auth",
      "logout",
      "--hostname",
      host,
      "--user",
      login.identity,
    ]);
    if (result.code !== 0)
      throw new Error(
        `GitHub CLI could not sign out: ${failure(result.stderr || result.stdout)}`,
      );
  },
  isolationEnvironment() {
    // An empty configuration folder: gh, and git through gh's credential
    // helper, find no login. Tokens from the environment are masked too.
    const empty = foundryStatePath("isolation", "gh");
    mkdirSync(empty, { recursive: true, mode: 0o700 });
    return {
      GH_CONFIG_DIR: join(empty),
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      GH_ENTERPRISE_TOKEN: "",
      GITHUB_ENTERPRISE_TOKEN: "",
    };
  },
};
