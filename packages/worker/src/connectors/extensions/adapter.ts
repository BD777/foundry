import type {
  ConnectorAuthorizationGroup,
  ConnectorAuthorizationState,
  ConnectorDescriptor,
  ExtensionSignInStep,
} from "@bd777/foundry-protocol";
import type {
  DeviceHeldAdapter,
  LoginReading,
  SignInStep,
} from "../device-held.js";
import type { InstallProgress } from "../aws-install.js";
import type { ExtensionHost } from "./host.js";

/**
 * A device-held adapter whose quirks live in an installed extension: each
 * call is one request to its process (./host.ts). The extension runs the
 * tool itself, so the worker neither finds nor runs it here.
 */

const statusTimeoutMs = 90_000;
const signInTimeoutMs = 120_000;
const quickTimeoutMs = 30_000;
const installTimeoutMs = 15 * 60_000;

/** What the extension read of the tool and its login. */
export interface ExtensionReading {
  installed: boolean;
  installSource: "foundry" | "device";
  version?: string;
  reading: LoginReading;
  authorizations?: ConnectorAuthorizationState[];
}

export interface ExtensionDeviceHeldAdapter extends DeviceHeldAdapter {
  /**
   * The whole reading in one request (status() uses it instead of the tool);
   * with `environment`, as the extension answers when those variables are
   * set (a session that may not use the login).
   */
  readState(environment?: Record<string, string>): Promise<ExtensionReading>;
}

function step(value: ExtensionSignInStep): SignInStep {
  return {
    status: value.status,
    challenge: value.challenge,
    verificationUrl: value.verificationUrl,
    userCode: value.userCode,
    codeEntry: value.codeEntry,
    error: value.error,
  };
}

export function extensionAdapter(
  host: ExtensionHost,
  connector: ConnectorDescriptor,
): ExtensionDeviceHeldAdapter {
  const extensionId = connector.adapter.slice("extension:".length);
  const kind = connector.kind;
  return {
    name: connector.adapter,
    runEnvironment: {},
    clearEnvironment: [],
    async readState(environment) {
      const result = await host.call(
        extensionId,
        "connector.status",
        { kind },
        statusTimeoutMs,
        undefined,
        environment,
      );
      const checkedAt = new Date().toISOString();
      return {
        installed: result.installed !== false,
        installSource:
          result.installSource === "foundry" ? "foundry" : "device",
        version:
          typeof result.version === "string"
            ? result.version.slice(0, 64)
            : undefined,
        reading: {
          signedIn: result.signedIn === true,
          identity: result.identity,
          sites: Array.isArray(result.sites) ? result.sites : undefined,
          expiresAt: result.expiresAt,
        },
        authorizations: result.authorizations?.map((authorization) => ({
          id: authorization.id,
          revision: authorization.revision,
          status: authorization.status,
          reason: authorization.reason,
          checkedAt,
          verification: "local_state" as const,
        })),
      };
    },
    async readVersion() {
      return (await this.readState()).version;
    },
    async readLogin() {
      return (await this.readState()).reading;
    },
    async beginSignIn(_run, scratch, options) {
      return step(
        await host.call(
          extensionId,
          "connector.signIn.begin",
          { kind, scratch, options: options ?? {} },
          signInTimeoutMs,
        ),
      );
    },
    async pollSignIn() {
      return step(
        await host.call(
          extensionId,
          "connector.signIn.poll",
          { kind },
          signInTimeoutMs,
        ),
      );
    },
    async signInInput(input) {
      await host.call(
        extensionId,
        "connector.signIn.input",
        { kind, input },
        quickTimeoutMs,
      );
    },
    async cancelSignIn() {
      await host.call(
        extensionId,
        "connector.signIn.cancel",
        { kind },
        quickTimeoutMs,
      );
    },
    async signOut() {
      await host.call(
        extensionId,
        "connector.signOut",
        { kind },
        signInTimeoutMs,
      );
    },
    async beginAuthorization(
      _run,
      scratch,
      group: ConnectorAuthorizationGroup,
    ) {
      const result = await host.call(
        extensionId,
        "connector.authorization.begin",
        { kind, scratch, group: group.id, revision: group.revision },
        signInTimeoutMs,
      );
      return { step: step(result.step), continuation: result.continuation };
    },
    async pollAuthorization(_run, group, continuation) {
      return step(
        await host.call(
          extensionId,
          "connector.authorization.poll",
          { kind, group: group.id, revision: group.revision, continuation },
          signInTimeoutMs,
        ),
      );
    },
    async install(_managedBin, progress?: (progress: InstallProgress) => void) {
      await host.call(
        extensionId,
        "connector.install",
        { kind },
        installTimeoutMs,
        progress &&
          ((report) =>
            progress({
              phase: report.phase,
              receivedBytes: report.receivedBytes,
              totalBytes: report.totalBytes,
            } as InstallProgress)),
      );
    },
  };
}
