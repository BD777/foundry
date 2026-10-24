import type {
  DeviceHeldAdapter,
  LoginReading,
  ToolResult,
} from "./device-held.js";

// Only STS identity metadata crosses the device boundary. Never return native
// stderr: credential_process and endpoint errors can contain secrets.
export function parseAWSIdentity(result: ToolResult): LoginReading {
  if (result.code !== 0) {
    if (
      /Unable to locate credentials|ExpiredToken|InvalidClientTokenId|UnrecognizedClientException|SSO session.*expired|Token has expired|Error loading SSO Token|config profile .* could not be found/i.test(
        result.stderr,
      )
    )
      return { signedIn: false };
    throw new Error(
      "AWS identity check failed. Check the device's network, region and credential configuration, then retry.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("AWS returned an invalid STS identity.");
  }
  const identity = value as { Account?: unknown; Arn?: unknown } | null;
  if (
    !identity ||
    typeof identity.Account !== "string" ||
    !/^\d{12}$/.test(identity.Account) ||
    typeof identity.Arn !== "string" ||
    !/^arn:aws(?:-[a-z-]+)?:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[\x21-\x7e]+$/.test(
      identity.Arn,
    ) ||
    identity.Arn.split(":")[4] !== identity.Account
  )
    throw new Error("AWS returned an invalid STS identity.");
  return { signedIn: true, identity: identity.Arn, sites: [identity.Account] };
}

const localAuthentication = async (): Promise<never> => {
  throw new Error(
    "Manage AWS authentication in the device terminal, then check again in Connectors.",
  );
};

export const awsAdapter: DeviceHeldAdapter = {
  name: "aws",
  // Preserve the same credential chain used by this worker's sessions.
  clearEnvironment: [],
  runEnvironment: {
    AWS_PAGER: "",
    AWS_CLI_AUTO_PROMPT: "off",
    AWS_MAX_ATTEMPTS: "1",
  },
  async readVersion(run) {
    const result = await run(["--version"]);
    if (result.code !== 0)
      throw new Error("Could not read the AWS CLI version.");
    const version = /aws-cli\/(\d+\.\d+\.\d+)/.exec(
      result.stdout + result.stderr,
    )?.[1];
    if (!version) throw new Error("Could not read the AWS CLI version.");
    return version;
  },
  async readLogin(run) {
    return parseAWSIdentity(
      await run(
        [
          "sts",
          "get-caller-identity",
          "--output",
          "json",
          "--cli-connect-timeout",
          "5",
          "--cli-read-timeout",
          "5",
        ],
        { timeoutMs: 20_000 },
      ),
    );
  },
  beginSignIn: localAuthentication,
  pollSignIn: localAuthentication,
  signOut: localAuthentication,
  isolationEnvironment() {
    // Empty values mask credentials supplied by an agent profile as well as
    // process.env. A null file prevents fallback to ~/.aws or credential_process.
    const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
    return {
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      AWS_SESSION_TOKEN: "",
      AWS_SECURITY_TOKEN: "",
      AWS_CREDENTIAL_FILE: nullFile,
      AWS_CONFIG_FILE: nullFile,
      AWS_SHARED_CREDENTIALS_FILE: nullFile,
      BOTO_CONFIG: nullFile,
      AWS_PROFILE: "foundry-no-login",
      AWS_DEFAULT_PROFILE: "foundry-no-login",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "",
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "",
      AWS_CONTAINER_AUTHORIZATION_TOKEN: "",
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "",
      AWS_WEB_IDENTITY_TOKEN_FILE: "",
      AWS_ROLE_ARN: "",
      AWS_ROLE_SESSION_NAME: "",
    };
  },
  sessionNote(use, command, reading) {
    if (use.access === "none")
      return `AWS CLI (${command}): this session is not authorized to use the device's AWS credentials. Keep the AWS credential isolation variables; do not read credential files or switch profiles to bypass it.`;
    return `AWS CLI (${command}) is available through this workspace's device binding. Use the device's native credential chain (AWS_PROFILE or default).${reading?.identity ? ` Last checked identity: ${reading.identity}.` : ""} Verify the current identity with sts get-caller-identity before acting; this does not prove service permissions. Do not change profiles, run configure/login/logout, or export credentials unless the person explicitly requests it. If credentials expire, ask the person to renew them in the device terminal and check Connectors again.`;
  },
};
