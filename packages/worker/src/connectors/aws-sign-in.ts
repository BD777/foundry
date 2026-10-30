import type { ChildProcess } from "node:child_process";
import type { SignInStep, ToolRun } from "./device-held.js";

/**
 * AWS CLI sign-in from a browser anywhere, driven on the device. The CLI
 * runs on the device and keeps the login there; the person approves in
 * their own browser, which is usually not on the device:
 *
 * - "console": `aws login --remote` (AWS CLI 2.32+), sign-in with the AWS
 *   Management Console session. The CLI prints a sign-in URL and waits for
 *   the authorization code the confirmation page shows; the person pastes it
 *   on the Foundry page and the worker hands it to the CLI.
 * - "sso": IAM Identity Center with `aws sso login --use-device-code` (2.22+)
 *   for the default profile, which Foundry first configures from what the
 *   person entered (start URL, SSO region, account and role). The CLI prints
 *   a URL and a code and polls by itself, so nothing is pasted back.
 *
 * Both write the default profile, the one sessions on the device use. The
 * worker keeps the running CLI between the page's requests and ends it on
 * dismissal, expiry or a new sign-in.
 */

export type AwsSignInMethod = "console" | "sso";

export interface AwsSignInOptions {
  method: AwsSignInMethod;
  region: string;
  startUrl?: string;
  ssoRegion?: string;
  accountId?: string;
  roleName?: string;
}

const regionPattern = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const startUrlPattern = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~/-]*)?$/;
const accountPattern = /^\d{12}$/;
const rolePattern = /^[\w+=,.@-]{1,64}$/;
const codePattern = /^[A-Za-z0-9._~+/=-]{4,4096}$/;

/** What the page sent, checked; throws a sentence for the person. */
export function parseAwsSignInOptions(
  raw: Record<string, string> | undefined,
): AwsSignInOptions {
  const method =
    raw?.method === "sso"
      ? "sso"
      : raw?.method === "console"
        ? "console"
        : undefined;
  if (!method) throw new Error("Choose how to sign in to AWS.");
  const region = (raw?.region ?? "").trim();
  if (!regionPattern.test(region))
    throw new Error("Enter an AWS Region such as us-east-1.");
  if (method === "console") return { method, region };
  const startUrl = (raw?.startUrl ?? "").trim();
  const ssoRegion = (raw?.ssoRegion ?? "").trim() || region;
  const accountId = (raw?.accountId ?? "").replace(/[\s-]/g, "");
  const roleName = (raw?.roleName ?? "").trim();
  if (!startUrlPattern.test(startUrl))
    throw new Error(
      "Enter your IAM Identity Center start URL, such as https://my-company.awsapps.com/start.",
    );
  if (!regionPattern.test(ssoRegion))
    throw new Error("Enter the Region of your IAM Identity Center.");
  if (!accountPattern.test(accountId))
    throw new Error("Enter the 12-digit AWS account ID.");
  if (!rolePattern.test(roleName))
    throw new Error("Enter the permission set (role) name to use.");
  return { method, region, startUrl, ssoRegion, accountId, roleName };
}

/** The sign-in URL `aws login --remote` prints. */
export function parseConsoleSignIn(output: string): string | undefined {
  return /https:\/\/[a-z0-9-]*\.?signin\.aws\.amazon\.com\/\S+/.exec(
    output,
  )?.[0];
}

/** The URL (with the code filled in, when printed) and code of a device sign-in. */
export function parseDeviceCodeSignIn(
  output: string,
): { url: string; code: string } | undefined {
  const code =
    /Then enter the code:\s*\n\s*\n?\s*([A-Z0-9]{4}-[A-Z0-9]{4})\s*$/m.exec(
      output,
    )?.[1];
  if (!code) return undefined;
  const urls = output.match(/https:\/\/\S+/g) ?? [];
  const complete = urls.find((url) => url.includes("user_code="));
  const url = complete ?? urls[0];
  return url ? { url, code } : undefined;
}

/** The CLI's own reason, in one line, without its "aws: [ERROR]:" prefix. */
export function signInFailure(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const error =
    lines.find((line) => /error|denied|expired|invalid/i.test(line)) ??
    lines.at(-1) ??
    "the AWS CLI ended without signing in";
  const description = /error_description:\s*(.+)/i.exec(output)?.[1]?.trim();
  const text = error.replace(/^aws:\s*\[ERROR\]:\s*/i, "").replace(/:\s*$/, "");
  return (
    description && !text.includes(description)
      ? `${text}: ${description}`
      : text
  ).slice(0, 240);
}

/** Compares dotted versions ("2.32.0" <= "2.39.1"). */
function atLeast(version: string | undefined, minimum: string): boolean {
  if (!version) return false;
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i += 1)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** The profile an IAM Identity Center sign-in runs under until it succeeded. */
export const stagingProfile = "foundry-sign-in";

async function configure(
  run: ToolRun,
  settings: [string, string][],
  profile: string,
): Promise<void> {
  for (const [key, value] of settings) {
    const set = await run([
      "configure",
      "set",
      key,
      value,
      "--profile",
      profile,
    ]);
    if (set.code !== 0)
      throw new Error(
        `Could not save the IAM Identity Center settings: ${signInFailure(`${set.stderr}\n${set.stdout}`)}`,
      );
  }
}

export const awsSignInMinimum: Record<AwsSignInMethod, string> = {
  console: "2.32.0",
  sso: "2.22.0",
};

const waitForPromptMs = 30_000;
const signInLifetimeMs = 5 * 60_000;

/** The one AWS sign-in running on this device, if any. */
export class AwsSignIn {
  private child: ChildProcess | undefined;
  private output = "";
  private exit: number | null | undefined;
  private expiry: NodeJS.Timeout | undefined;
  /** IAM Identity Center settings for the default profile once signed in. */
  private adopt: [string, string][] | undefined;
  private run: ToolRun | undefined;

  async begin(
    run: ToolRun,
    options: AwsSignInOptions,
    version: string | undefined,
  ): Promise<SignInStep> {
    this.cancel();
    if (!run.spawn) throw new Error("This worker cannot run AWS sign-in.");
    if (!atLeast(version, awsSignInMinimum[options.method]))
      throw new Error(
        options.method === "console"
          ? `Browser sign-in needs AWS CLI ${awsSignInMinimum.console} or newer (this device has ${version ?? "an unknown version"}). Update AWS CLI first.`
          : `IAM Identity Center sign-in needs AWS CLI ${awsSignInMinimum.sso} or newer (this device has ${version ?? "an unknown version"}). Update AWS CLI first.`,
      );
    let args: string[];
    if (options.method === "console") {
      // Sessions read the default profile; give it a Region if it has none.
      const current = await run([
        "configure",
        "get",
        "region",
        "--profile",
        "default",
      ]);
      if (!current.stdout.trim())
        await run([
          "configure",
          "set",
          "region",
          options.region,
          "--profile",
          "default",
        ]);
      args = ["login", "--remote", "--region", options.region];
    } else {
      const settings: [string, string][] = [
        ["sso_start_url", options.startUrl!],
        ["sso_region", options.ssoRegion!],
        ["sso_account_id", options.accountId!],
        ["sso_role_name", options.roleName!],
        ["region", options.region],
      ];
      // Signed in under a staging profile first: the default profile (what
      // sessions use) changes only once the sign-in succeeded (poll).
      await configure(run, settings, stagingProfile);
      this.adopt = settings;
      this.run = run;
      args = [
        "sso",
        "login",
        "--use-device-code",
        "--no-browser",
        "--profile",
        stagingProfile,
      ];
    }
    const child = run.spawn(args);
    this.child = child;
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
      if (options.method === "console") {
        const url = parseConsoleSignIn(this.output);
        if (url)
          return { status: "pending", verificationUrl: url, codeEntry: true };
      } else {
        const found = parseDeviceCodeSignIn(this.output);
        if (found)
          return {
            status: "pending",
            verificationUrl: found.url,
            userCode: found.code,
          };
      }
      if (this.exit !== undefined)
        return { status: "failed", error: signInFailure(this.output) };
      if (Date.now() - started > waitForPromptMs) {
        this.cancel();
        return {
          status: "failed",
          error: "The AWS CLI did not show a sign-in page in time.",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** Where the running sign-in stands. */
  async poll(): Promise<SignInStep> {
    if (!this.child) return { status: "expired" };
    if (this.exit === undefined) return { status: "pending" };
    const output = this.output;
    const exit = this.exit;
    const adopt = this.adopt;
    const run = this.run;
    this.finish();
    if (exit === 0 && adopt && run) {
      try {
        await configure(run, adopt, "default");
      } catch (error) {
        return { status: "failed", error: (error as Error).message };
      }
    }
    if (exit === 0) return { status: "complete" };
    if (/denied|AccessDenied/i.test(output))
      return { status: "denied", error: signInFailure(output) };
    if (/expired/i.test(output))
      return { status: "expired", error: signInFailure(output) };
    return { status: "failed", error: signInFailure(output) };
  }

  /** Hands the authorization code from the confirmation page to the CLI. */
  input(code: string): void {
    const value = code.trim();
    if (!codePattern.test(value))
      throw new Error(
        "That does not look like the authorization code AWS showed.",
      );
    if (!this.child || this.exit !== undefined || !this.child.stdin?.writable)
      throw new Error(
        "This sign-in is no longer waiting for a code; start again.",
      );
    this.child.stdin.write(`${value}\n`);
  }

  cancel(): void {
    if (this.child && this.exit === undefined) {
      const pid = this.child.pid;
      try {
        // The CLI's whole process group (spawned detached).
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
    this.adopt = undefined;
    this.run = undefined;
  }
}
