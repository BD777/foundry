import type {
  DeviceHeldAdapter,
  LoginReading,
  SignInStep,
  ToolResult,
  ToolRun,
} from "./device-held.js";
import { CliSignIn } from "./cli-sign-in.js";
import { installAliyunCli } from "./alibabacloud-install.js";

/**
 * Alibaba Cloud CLI (aliyun, github.com/aliyun/aliyun-cli) as a device-held
 * connector. aliyun keeps its login in ~/.aliyun/config.json and refreshes
 * it itself; Foundry only runs its public commands:
 *
 * - "oauth": `aliyun configure --mode OAuth --no-browser` (3.5.2+,
 *   config/oauth_manual.go, help.aliyun.com/zh/cli/oauth-credentials) prints
 *   the sign-in page; after approving, the browser lands on a
 *   http://127.0.0.1:12345/cli/callback address that does not load, and the
 *   person pastes that whole address back. A RAM administrator first installs
 *   the official-cli OAuth application and allows the person's identity.
 * - "sso": CloudSSO. `aliyun configure sso login --sso-session foundry
 *   --cloud-sso-sign-in-url` shows a device code and polls by itself
 *   (cloudsso/login.go); once signed in, `aliyun configure set --mode
 *   CloudSSO` points the default profile at the account and access
 *   configuration.
 *
 * Both write the profile named default and make it the current one, the one
 * sessions use. Identity is read with STS GetCallerIdentity; stderr never
 * leaves the device.
 */

const regionPattern = /^[a-z]{2}(-[a-z0-9]+){1,4}$/;
const accountPattern = /^\d{6,20}$/;
const accessConfigPattern = /^ac-[A-Za-z0-9]{4,64}$/;
const ssoUrlPattern = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[\w.~%/-]*)?$/;
const callbackPrefix = "http://127.0.0.1:12345/cli/callback?";
/** The CloudSSO session Foundry signs in for the default profile. */
export const aliyunSsoSession = "foundry";

export type AliyunSignInMethod = "oauth" | "sso";

export interface AliyunSignInOptions {
  method: AliyunSignInMethod;
  region: string;
  site?: "CN" | "INTL";
  signInUrl?: string;
  accountId?: string;
  accessConfig?: string;
}

/** What the page sent, checked; throws a sentence for the person. */
export function parseAliyunSignInOptions(
  raw: Record<string, string> | undefined,
): AliyunSignInOptions {
  const method =
    raw?.method === "oauth" || raw?.method === "sso" ? raw.method : undefined;
  if (!method) throw new Error("Choose how to sign in to Alibaba Cloud.");
  const region = (raw?.region ?? "").trim();
  if (!regionPattern.test(region))
    throw new Error("Enter an Alibaba Cloud Region such as cn-hangzhou.");
  if (method === "oauth") {
    const site = (raw?.site ?? "CN").trim().toUpperCase();
    if (site !== "CN" && site !== "INTL")
      throw new Error("Choose the China site or the international site.");
    return { method, region, site };
  }
  const signInUrl = (raw?.signInUrl ?? "").trim();
  const accountId = (raw?.accountId ?? "").trim();
  const accessConfig = (raw?.accessConfig ?? "").trim();
  if (!ssoUrlPattern.test(signInUrl))
    throw new Error(
      "Enter the CloudSSO user sign-in URL, an https address from the CloudSSO console.",
    );
  if (!accountPattern.test(accountId))
    throw new Error("Enter the Alibaba Cloud account ID (UID) to sign in to.");
  if (!accessConfigPattern.test(accessConfig))
    throw new Error(
      "Enter the CloudSSO access configuration ID, which starts with ac-.",
    );
  return { method, region, signInUrl, accountId, accessConfig };
}

interface AliyunError {
  message?: string;
  error_code?: string;
  recovery?: { action?: string };
}

/** aliyun's JSON error on stderr (schemaVersion v1), if it wrote one. */
function aliyunError(stderr: string): AliyunError | undefined {
  const start = stderr.indexOf("{");
  if (start < 0) return undefined;
  try {
    const value = JSON.parse(stderr.slice(start)) as unknown;
    return value && typeof value === "object"
      ? (value as AliyunError)
      : undefined;
  } catch {
    return undefined;
  }
}

const signedOutCodes =
  /^(InvalidAccessKeyId(\..+)?|SignatureDoesNotMatch|InvalidSecurityToken(\..+)?|InvalidBearerToken(\..+)?)$/;

// Only STS identity metadata crosses the device boundary.
export function parseAliyunIdentity(result: ToolResult): LoginReading {
  if (result.code !== 0) {
    const error = aliyunError(result.stderr);
    if (
      error?.recovery?.action === "check_configuration" ||
      (error?.error_code && signedOutCodes.test(error.error_code)) ||
      /not logged in or has expired|refresh token|OAuth|sso login/i.test(
        error?.message ?? result.stderr,
      ) ||
      // A device with no profile yet: aliyun's first run answers in plain
      // text ("region can't be empty … Configuration failed").
      (!error &&
        /Configuration failed, use `aliyun configure`/.test(result.stderr))
    )
      return { signedIn: false };
    throw new Error(
      "Alibaba Cloud identity check failed. Check the device's network and aliyun configuration, then retry.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("Alibaba Cloud returned an invalid STS identity.");
  }
  const identity = value as { AccountId?: unknown; Arn?: unknown } | null;
  if (
    !identity ||
    typeof identity.AccountId !== "string" ||
    !accountPattern.test(identity.AccountId) ||
    typeof identity.Arn !== "string" ||
    identity.Arn.length > 512 ||
    !/^acs:[a-z]+::\d{6,20}:[\x21-\x7e]+$/.test(identity.Arn) ||
    identity.Arn.split(":")[3] !== identity.AccountId
  )
    throw new Error("Alibaba Cloud returned an invalid STS identity.");
  return {
    signedIn: true,
    identity: identity.Arn,
    sites: [identity.AccountId],
  };
}

/** The sign-in page `aliyun configure --mode OAuth --no-browser` prints. */
export function parseAliyunOAuthPage(output: string): string | undefined {
  return /https:\/\/signin\.(?:aliyun|alibabacloud)\.com\/oauth2\/v1\/auth\?\S+/.exec(
    output,
  )?.[0];
}

/** The page and code `aliyun configure sso login` prints. */
export function parseAliyunDeviceCode(
  output: string,
): { url: string; code: string } | undefined {
  const url = /(?:SignIn url|登录URL):\s*(https:\/\/\S+)/.exec(output)?.[1];
  const code = /(?:User code|用户码):\s*([A-Za-z0-9-]{4,32})/.exec(output)?.[1];
  return url && code ? { url, code } : undefined;
}

/** The pasted address, checked to be aliyun's callback with a code. */
export function checkedCallback(input: string): string {
  const value = input.trim();
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (
    !url ||
    !value.startsWith(callbackPrefix) ||
    value.length > 8192 ||
    !url.searchParams.get("state") ||
    !(url.searchParams.get("code") || url.searchParams.get("error"))
  )
    throw new Error(
      "Paste the whole address from the browser's address bar after signing in; it starts with http://127.0.0.1:12345/cli/callback?",
    );
  return value;
}

/** Why aliyun ended without signing in, in a fixed sentence. */
export function aliyunSignInFailure(output: string): string {
  if (/You are not allowed to do this action/i.test(output))
    return "Alibaba Cloud refused the sign-in: a RAM administrator has to install the official-cli OAuth application (RAM console › Integrations › OAuth Applications) and allow your identity first.";
  if (/denied or failed/i.test(output))
    return "The sign-in was denied or failed on Alibaba Cloud's page.";
  if (/invalid state|invalid OAuth callback/i.test(output))
    return "aliyun did not accept that address: paste the address from this sign-in, not an earlier one.";
  if (/request has expired|请求已过期|Login timeout|登录超时/i.test(output))
    return "The sign-in request expired before it was approved.";
  if (
    /Parse sign in url error|Start Device Authorization error|启动设备授权失败/i.test(
      output,
    )
  )
    return "aliyun could not start CloudSSO sign-in with that URL. Check the CloudSSO user sign-in URL.";
  return "aliyun ended without signing in.";
}

function atLeast(version: string | undefined, minimum: string): boolean {
  if (!version) return false;
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i += 1)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** Pasting the callback by hand arrived in 3.5.2; CloudSSO sessions earlier. */
const signInMinimum = "3.5.2";

/** The one aliyun sign-in running on this device, if any. */
export class AliyunSignIn {
  private readonly cli = new CliSignIn();
  private options: AliyunSignInOptions | undefined;
  private run: ToolRun | undefined;
  /** Set once the callback address went to aliyun. */
  private sent = false;

  async begin(
    run: ToolRun,
    options: AliyunSignInOptions,
    version: string | undefined,
  ): Promise<SignInStep> {
    this.cancel();
    if (!atLeast(version, signInMinimum))
      throw new Error(
        `This sign-in needs Alibaba Cloud CLI ${signInMinimum} or newer (this device has ${version ?? "an unknown version"}). Update it first.`,
      );
    this.options = options;
    this.run = run;
    if (options.method === "sso") {
      this.cli.start(run, [
        "configure",
        "sso",
        "login",
        "--sso-session",
        aliyunSsoSession,
        "--cloud-sso-sign-in-url",
        options.signInUrl!,
      ]);
      const found = await this.cli.waitFor(parseAliyunDeviceCode);
      if (found)
        return {
          status: "pending",
          verificationUrl: found.url,
          userCode: found.code,
        };
    } else {
      this.cli.start(run, [
        "configure",
        "--mode",
        "OAuth",
        "--profile",
        "default",
        "--no-browser",
      ]);
      // The site prompt appears only when the profile names no site yet.
      const first = await this.cli.waitFor((output) =>
        parseAliyunOAuthPage(output)
          ? "page"
          : /OAuth Site Type/.test(output)
            ? "site"
            : undefined,
      );
      if (first === "site") this.cli.send(options.site === "INTL" ? "1" : "0");
      const page = await this.cli.waitFor(parseAliyunOAuthPage);
      if (page) {
        const site = page.includes("signin.alibabacloud.com") ? "INTL" : "CN";
        if (site === options.site)
          return {
            status: "pending",
            verificationUrl: page,
            codeEntry: true,
            codeEntryFormat: "callback_url",
          };
        this.cancel();
        return {
          status: "failed",
          error: `The device's default aliyun profile already signs in on the ${site === "CN" ? "China" : "international"} site; choose that site, or change it in a terminal on the device.`,
        };
      }
    }
    const failure =
      this.cli.exit !== undefined
        ? aliyunSignInFailure(this.cli.output)
        : "aliyun did not show a sign-in page in time.";
    this.cancel();
    return { status: "failed", error: failure };
  }

  async poll(): Promise<SignInStep> {
    if (!this.cli.started) return { status: "expired" };
    if (this.cli.running) {
      // aliyun asks again when it rejects the address; that sign-in is spent.
      if (
        this.sent &&
        /Please paste the complete callback URL/.test(this.cli.output)
      ) {
        const error = aliyunSignInFailure(this.cli.output);
        this.cancel();
        return { status: "failed", error };
      }
      return { status: "pending" };
    }
    const exit = this.cli.exit;
    const output = this.cli.output;
    const options = this.options;
    const run = this.run;
    this.cli.finish();
    this.sent = false;
    if (exit !== 0)
      return {
        status: /expired|过期|timeout|超时/i.test(output)
          ? "expired"
          : "failed",
        error: aliyunSignInFailure(output),
      };
    if (options?.method === "sso" && run) {
      const set = await run([
        "configure",
        "set",
        "--profile",
        "default",
        "--mode",
        "CloudSSO",
        "--sso-session",
        aliyunSsoSession,
        "--cloud-sso-account-id",
        options.accountId!,
        "--cloud-sso-access-config",
        options.accessConfig!,
        "--region",
        options.region,
      ]);
      if (set.code !== 0)
        return {
          status: "failed",
          error:
            "Signed in to CloudSSO, but aliyun could not set up the default profile with that account and access configuration.",
        };
      return { status: "complete" };
    }
    return /Saving profile\[default\] \.\.\.Done\./.test(output)
      ? { status: "complete" }
      : { status: "failed", error: aliyunSignInFailure(output) };
  }

  /** Hands the callback address to the waiting aliyun, then its prompts. */
  input(text: string): void {
    if (this.options?.method !== "oauth" || this.sent)
      throw new Error(
        "This sign-in is not waiting for an address; start again.",
      );
    const value = checkedCallback(text);
    this.cli.send(value);
    this.sent = true;
    const region = this.options.region;
    // After the exchange aliyun asks for the default Region, then the
    // language (an empty line keeps the profile's, or the system's).
    void (async () => {
      if (
        await this.cli.waitFor(
          (o) => (/Default Region Id \[/.test(o) ? true : undefined),
          60_000,
        )
      )
        this.cli.send(region);
      if (
        await this.cli.waitFor(
          (o) => (/Default Language \[/.test(o) ? true : undefined),
          30_000,
        )
      )
        this.cli.send("");
    })().catch(() => undefined);
  }

  cancel(): void {
    this.cli.cancel();
    this.sent = false;
    this.options = undefined;
    this.run = undefined;
  }
}

const signIn = new AliyunSignIn();

export const alibabaCloudAdapter: DeviceHeldAdapter = {
  name: "alibabacloud",
  clearEnvironment: [],
  runEnvironment: { ALIBABA_CLOUD_CLI_TELEMETRY_DISABLE: "true" },
  async readVersion(run) {
    const result = await run(["version"]);
    const version = /^(\d+\.\d+\.\d+)\s*$/.exec(result.stdout.trim())?.[1];
    if (result.code !== 0 || !version)
      throw new Error("Could not read the Alibaba Cloud CLI version.");
    return version;
  },
  async readLogin(run) {
    return parseAliyunIdentity(
      await run(
        [
          "sts",
          "GetCallerIdentity",
          "--connect-timeout",
          "5",
          "--read-timeout",
          "10",
        ],
        { timeoutMs: 30_000 },
      ),
    );
  },
  async install(managedBin, progress) {
    await installAliyunCli({ managedBin, progress });
  },
  async beginSignIn(run, _scratch, options) {
    const chosen = parseAliyunSignInOptions(options);
    let version: string | undefined;
    try {
      version = await alibabaCloudAdapter.readVersion(run);
    } catch {
      version = undefined;
    }
    return signIn.begin(run, chosen, version);
  },
  pollSignIn() {
    return signIn.poll();
  },
  signInInput(input) {
    signIn.input(input);
  },
  cancelSignIn() {
    signIn.cancel();
  },
  async signOut() {
    throw new Error(
      "Sign out of aliyun in the device terminal (aliyun configure delete --profile default), then check again in Connectors.",
    );
  },
  isolationEnvironment() {
    // ALIBABA_CLOUD_IGNORE_PROFILE=TRUE makes aliyun skip ~/.aliyun even with
    // --profile (config/configuration.go); the empty variables mask keys an
    // agent profile might supply, so nothing is left to sign with.
    return {
      ALIBABA_CLOUD_IGNORE_PROFILE: "TRUE",
      ALIBABACLOUD_IGNORE_PROFILE: "TRUE",
      ALIBABA_CLOUD_PROFILE: "foundry-no-login",
      ALIBABA_CLOUD_ACCESS_KEY_ID: "",
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: "",
      ALIBABA_CLOUD_SECURITY_TOKEN: "",
      ALIBABACLOUD_ACCESS_KEY_ID: "",
      ALIBABACLOUD_ACCESS_KEY_SECRET: "",
      ALIBABACLOUD_SECURITY_TOKEN: "",
      ALICLOUD_ACCESS_KEY_ID: "",
      ALICLOUD_ACCESS_KEY_SECRET: "",
      ALICLOUD_SECURITY_TOKEN: "",
      ALIBABA_CLOUD_BEARER_TOKEN: "",
      ALIBABA_CLOUD_ROLE_ARN: "",
      ALIBABA_CLOUD_OIDC_PROVIDER_ARN: "",
      ALIBABA_CLOUD_OIDC_TOKEN_FILE: "",
    };
  },
};
