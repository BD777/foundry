import type {
  DeviceHeldAdapter,
  LoginReading,
  SignInStep,
  ToolResult,
  ToolRun,
} from "./device-held.js";
import { CliSignIn } from "./cli-sign-in.js";
import { installTccli } from "./tencentcloud-install.js";

/**
 * Tencent Cloud CLI (tccli, github.com/TencentCloud/tencentcloud-cli) as a
 * device-held connector. tccli keeps its login in ~/.tccli/<profile>.credential
 * and refreshes it itself before each command; Foundry only runs its public
 * commands:
 *
 * - "oauth": `tccli auth login --browser no` (tccli/plugins/auth/login.py)
 *   prints Tencent Cloud's authorization page and waits for the code that
 *   page shows; the person pastes it back on the Foundry page.
 * - "sso": Tencent Cloud CIC (identity center). `tccli sso configure --url`
 *   saves the user sign-in URL, then `tccli sso login --uin --rolename`
 *   (tccli/plugins/sso/login.py) prints a page and polls by itself.
 *
 * Both write the default profile, the one sessions use. Identity is read
 * with STS GetCallerIdentity; stderr never leaves the device.
 */

const regionPattern = /^[a-z]{2,3}(-[a-z0-9]+){1,4}$/;
const uinPattern = /^\d{5,20}$/;
const rolePattern = /^[\w+=,.@-]{1,128}$/;
const ssoUrlPattern = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[\w.~%/-]*)?$/;
// The page shows base64 of a small JSON document.
const oauthCodePattern = /^[A-Za-z0-9+/=_-]{16,8192}$/;
/** STS checks are global; tccli still needs some Region to sign with. */
const identityRegion = "ap-guangzhou";

export type TencentSignInMethod = "oauth" | "sso";

export interface TencentSignInOptions {
  method: TencentSignInMethod;
  region: string;
  signInUrl?: string;
  accountId?: string;
  roleName?: string;
}

/** What the page sent, checked; throws a sentence for the person. */
export function parseTencentSignInOptions(
  raw: Record<string, string> | undefined,
): TencentSignInOptions {
  const method =
    raw?.method === "oauth" || raw?.method === "sso" ? raw.method : undefined;
  if (!method) throw new Error("Choose how to sign in to Tencent Cloud.");
  const region = (raw?.region ?? "").trim();
  if (!regionPattern.test(region))
    throw new Error("Enter a Tencent Cloud Region such as ap-guangzhou.");
  if (method === "oauth") return { method, region };
  const signInUrl = (raw?.signInUrl ?? "").trim();
  const accountId = (raw?.accountId ?? "").trim();
  const roleName = (raw?.roleName ?? "").trim();
  if (!ssoUrlPattern.test(signInUrl))
    throw new Error(
      "Enter the CIC user sign-in URL, an https address from the CIC console.",
    );
  if (!uinPattern.test(accountId))
    throw new Error("Enter the account ID (UIN) to sign in to.");
  if (!rolePattern.test(roleName))
    throw new Error("Enter the CIC permission configuration (role) name.");
  return { method, region, signInUrl, accountId, roleName };
}

// Only STS identity metadata crosses the device boundary.
export function parseTencentIdentity(result: ToolResult): LoginReading {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    if (
      /secretId is invalid|'_sys_param'|AuthFailure\.(SecretIdNotFound|InvalidSecretId|SignatureFailure|TokenFailure|InvalidAuthorization)|InvalidCredential/i.test(
        output,
      )
    )
      return { signedIn: false };
    throw new Error(
      "Tencent Cloud identity check failed. Check the device's network and tccli configuration, then retry.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("Tencent Cloud returned an invalid STS identity.");
  }
  const identity = value as { AccountId?: unknown; Arn?: unknown } | null;
  if (
    !identity ||
    typeof identity.AccountId !== "string" ||
    !uinPattern.test(identity.AccountId) ||
    typeof identity.Arn !== "string" ||
    identity.Arn.length > 512 ||
    !/^qcs::[\x21-\x7e]+$/.test(identity.Arn) ||
    !identity.Arn.includes(identity.AccountId)
  )
    throw new Error("Tencent Cloud returned an invalid STS identity.");
  return {
    signedIn: true,
    identity: identity.Arn,
    sites: [identity.AccountId],
  };
}

/** Tencent's authorization page `tccli auth login --browser no` prints. */
export function parseTencentOAuthPage(output: string): string | undefined {
  return /https:\/\/cloud\.tencent\.com\/open\/authorize\?\S+/.exec(
    output,
  )?.[0];
}

/** The CIC page `tccli sso login` prints (the configured URL plus its state). */
export function parseTencentSsoPage(output: string): string | undefined {
  return /https:\/\/\S+[?&]loginType=tccli\S*/.exec(output)?.[0];
}

/**
 * Why tccli ended without signing in, in a fixed sentence or tccli's own
 * one-line message for a wrong account or role (names only, no secret).
 */
export function tencentSignInFailure(output: string, codeSent = false): string {
  const named =
    /(Specified (?:uin|role) not found[^\n]*|no account found[^\n]*|no role found[^\n]*|sso url is not configured[^\n]*|invalid duration[^\n]*|Invalid auth url[^\n]*)/i.exec(
      output,
    )?.[1];
  if (named) return named.trim().slice(0, 240);
  if (codeSent || /Traceback|Error|Exception/.test(output))
    return "tccli could not finish the sign-in. Start again, and paste the whole code the page shows.";
  return "tccli ended without signing in.";
}

async function setRegion(run: ToolRun, region: string): Promise<void> {
  const set = await run(["configure", "set", "region", region]);
  if (set.code !== 0)
    throw new Error("Could not save the default Region in tccli.");
}

const signInMinimum: Record<TencentSignInMethod, string> = {
  // The auth plugin (with --browser no) arrived in 3.0.1190.1; --uin and
  // --rolename for sso login in 3.0.1341.1.
  oauth: "3.0.1190",
  sso: "3.0.1341",
};

function atLeast(version: string | undefined, minimum: string): boolean {
  if (!version) return false;
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i += 1)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** The one tccli sign-in running on this device, if any. */
export class TencentSignIn {
  private readonly cli = new CliSignIn();
  private codeSent = false;

  async begin(
    run: ToolRun,
    options: TencentSignInOptions,
    version: string | undefined,
  ): Promise<SignInStep> {
    this.cancel();
    if (!atLeast(version, signInMinimum[options.method]))
      throw new Error(
        `This sign-in needs tccli ${signInMinimum[options.method]} or newer (this device has ${version ?? "an unknown version"}). Update tccli first.`,
      );
    if (options.method === "sso") {
      const configured = await run([
        "sso",
        "configure",
        "--url",
        options.signInUrl!,
        "--profile",
        "default",
        "--language",
        "en-US",
      ]);
      if (configured.code !== 0 || /invalid/i.test(configured.stdout))
        throw new Error("tccli did not accept that CIC sign-in URL.");
    }
    await setRegion(run, options.region);
    if (options.method === "oauth") {
      this.cli.start(run, [
        "auth",
        "login",
        "--browser",
        "no",
        "--profile",
        "default",
        "--language",
        "en-US",
      ]);
      const page = await this.cli.waitFor(parseTencentOAuthPage);
      if (page)
        return { status: "pending", verificationUrl: page, codeEntry: true };
    } else {
      this.cli.start(run, [
        "sso",
        "login",
        "--uin",
        options.accountId!,
        "--rolename",
        options.roleName!,
        "--profile",
        "default",
        "--language",
        "en-US",
      ]);
      const page = await this.cli.waitFor(parseTencentSsoPage);
      if (page) return { status: "pending", verificationUrl: page };
    }
    const failure =
      this.cli.exit !== undefined
        ? tencentSignInFailure(this.cli.output)
        : "tccli did not show a sign-in page in time.";
    this.cli.cancel();
    return { status: "failed", error: failure };
  }

  poll(): SignInStep {
    if (!this.cli.started) return { status: "expired" };
    if (this.cli.running) return { status: "pending" };
    const exit = this.cli.exit;
    const output = this.cli.output;
    const codeSent = this.codeSent;
    this.cli.finish();
    this.codeSent = false;
    // tccli sso login prints a reason and exits 0 when the account or role
    // is not offered; only its success line means a login was saved.
    if (exit === 0 && /Login succeed/.test(output))
      return { status: "complete" };
    return { status: "failed", error: tencentSignInFailure(output, codeSent) };
  }

  /** Hands the code from Tencent Cloud's page to the waiting tccli. */
  input(code: string): void {
    const value = code.trim();
    if (!oauthCodePattern.test(value))
      throw new Error(
        "That does not look like the code Tencent Cloud showed. Copy the whole code.",
      );
    this.cli.send(value);
    this.codeSent = true;
  }

  cancel(): void {
    this.cli.cancel();
    this.codeSent = false;
  }
}

const signIn = new TencentSignIn();

export const tencentCloudAdapter: DeviceHeldAdapter = {
  name: "tencentcloud",
  clearEnvironment: [],
  runEnvironment: {},
  async readVersion(run) {
    const result = await run(["--version"]);
    const version = /^(\d+\.\d+\.\d+(?:\.\d+)?)\s*$/.exec(
      result.stdout.trim(),
    )?.[1];
    if (result.code !== 0 || !version)
      throw new Error("Could not read the tccli version.");
    return version;
  },
  async readLogin(run) {
    return parseTencentIdentity(
      await run(
        [
          "sts",
          "GetCallerIdentity",
          "--region",
          identityRegion,
          "--timeout",
          "10",
          "--output",
          "json",
        ],
        { timeoutMs: 30_000 },
      ),
    );
  },
  async install(managedBin, progress) {
    await installTccli({ managedBin, progress });
  },
  async beginSignIn(run, _scratch, options) {
    const chosen = parseTencentSignInOptions(options);
    let version: string | undefined;
    try {
      version = await tencentCloudAdapter.readVersion(run);
    } catch {
      version = undefined;
    }
    return signIn.begin(run, chosen, version);
  },
  async pollSignIn() {
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
      "Sign out of tccli in the device terminal (tccli auth logout), then check again in Connectors.",
    );
  },
  isolationEnvironment() {
    // tccli has no variable for its config folder: an unknown profile makes
    // it fail before reading ~/.tccli, and empty variables mask keys an
    // agent profile might supply. An explicit --profile still reads the
    // folder; this prevents mistakes, it is not a boundary.
    return {
      TCCLI_PROFILE: "foundry-no-login",
      TENCENTCLOUD_SECRET_ID: "",
      TENCENTCLOUD_SECRET_KEY: "",
      TENCENTCLOUD_TOKEN: "",
      TENCENTCLOUD_ROLE_ARN: "",
      TENCENTCLOUD_ROLE_SESSION_NAME: "",
      TKE_PROVIDER_ID: "",
      TKE_WEB_IDENTITY_TOKEN_FILE: "",
      TKE_ROLE_ARN: "",
    };
  },
};
