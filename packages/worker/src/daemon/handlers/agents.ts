import {
  daemonMessageTypes,
  type ExternalConnectionRequestPayload,
  type ListAgentModelsPayload,
  type ReadProviderKeyPayload,
  type UpsertAgentProfilePayload,
  type UpsertAgentRuntimeSettingsPayload,
} from "@bd777/foundry-protocol";
import { writeAgentRuntimeSettings } from "../../device.js";
import { listAgentModelsConfig } from "../../models.js";
import { installNativeCli } from "../../native-cli-install.js";
import {
  NativeAccountChangedError,
  inspectSelectedAccount,
} from "../../native-quota-cache.js";
import { inspectNativeAccount } from "../../native-inspection.js";
import {
  ExternalConnectionError,
  removeExternalConnection,
} from "../../external-connection-registry.js";
import { checkExternalConnection } from "../../provider-check.js";
import { clearNativeLoginHealth } from "../../native-login.js";
import { refreshOfficialSkills } from "../../official-skills.js";
import {
  configuredProviderKey,
  upsertAgentProfileConfig,
} from "../../profiles.js";
import { sendWebSocket, trySendWebSocket } from "../../transport.js";
import { workspaceFolderPresent } from "../../workspace-registration.js";
import type { daemonRegistration } from "../../workspace-ops.js";
import { reply, type DaemonDispatch } from "../dispatch.js";
import { errorMessage } from "../../utils.js";

function hasWorkspace(
  registration: object,
): registration is ReturnType<typeof daemonRegistration> {
  return "workspace" in registration && Boolean(registration.workspace);
}

/** Agent runtimes on the device: native accounts and CLIs, profiles, models. */
export function registerAgentHandlers(dispatch: DaemonDispatch): void {
  dispatch
    .on(daemonMessageTypes.inspectNativeAccount, (envelope, ctx) => {
      const input = envelope.payload as {
        runtime?: string;
        source?: string;
        runtimeGeneration?: string;
        refresh?: boolean;
      };
      if (input?.runtime !== "claude" && input?.runtime !== "codex") {
        trySendWebSocket(
          ctx.socket,
          daemonMessageTypes.nativeAccountInspected,
          { error: "Unknown runtime." },
          envelope.id,
        );
        return;
      }
      void (
        input.runtimeGeneration
          ? inspectSelectedAccount(
              input.runtime,
              input.runtimeGeneration,
              input.refresh,
            )
          : inspectNativeAccount(input.runtime, input.source)
      )
        .catch((error: unknown) => {
          const reason = errorMessage(error);
          console.error(
            `Inspecting the ${input.runtime} account failed: ${reason}`,
          );
          trySendWebSocket(
            ctx.socket,
            daemonMessageTypes.nativeAccountInspected,
            {
              error: `Could not inspect this native account: ${reason}`,
              ...(error instanceof NativeAccountChangedError
                ? { errorCode: "account_changed" }
                : {}),
            },
            envelope.id,
          );
          return undefined;
        })
        .then((result) => {
          if (!result) return;
          // The device's agent list shows the same login: refresh it with
          // this check instead of a status cached before, say, the CLI
          // was installed.
          clearNativeLoginHealth();
          trySendWebSocket(
            ctx.socket,
            daemonMessageTypes.nativeAccountInspected,
            {
              result,
              registration: ctx.roster.currentRegistration(),
            },
            envelope.id,
          );
        })
        .catch((error: unknown) => {
          const reason = errorMessage(error);
          console.error(`Reporting the account check failed: ${reason}`);
          trySendWebSocket(
            ctx.socket,
            daemonMessageTypes.nativeAccountInspected,
            {
              error: `The account check finished but could not be reported: ${reason}`,
            },
            envelope.id,
          );
        });
    })
    .on(daemonMessageTypes.installNativeCli, (envelope, ctx) => {
      const input = envelope.payload as { runtime?: string };
      if (input?.runtime !== "claude" && input?.runtime !== "codex") {
        trySendWebSocket(
          ctx.socket,
          daemonMessageTypes.nativeCliInstalled,
          { error: "Unknown runtime." },
          envelope.id,
        );
        return;
      }
      const runtime = input.runtime;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.nativeCliInstalled,
        async () => {
          const result = await installNativeCli(runtime);
          // A newly installed program brings its own skills; read them
          // before reporting the device again.
          if (result.ok)
            await refreshOfficialSkills([runtime]).catch(() => false);
          return { result, registration: ctx.roster.currentRegistration() };
        },
      );
    })
    // Explicit external connection management from the Devices page. A
    // check runs one native conversation (up to two minutes) and is not
    // awaited, so other requests keep flowing. Both answers carry a fresh
    // registration so the page shows the new state at once.
    .on(daemonMessageTypes.checkExternalConnection, (envelope, ctx) => {
      const { profileId } = (envelope.payload ??
        {}) as Partial<ExternalConnectionRequestPayload>;
      void reply(
        ctx,
        envelope,
        daemonMessageTypes.externalConnectionChecked,
        async () => {
          const result = await checkExternalConnection(profileId ?? "");
          return {
            result: {
              status: result.status,
              checkedAt: result.checkedAt,
              message: result.message,
            },
            registration: ctx.roster.currentRegistration(),
          };
        },
        externalConnectionFailure,
      );
    })
    .on(daemonMessageTypes.removeExternalConnection, (envelope, ctx) => {
      const { profileId } = (envelope.payload ??
        {}) as Partial<ExternalConnectionRequestPayload>;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.externalConnectionRemoved,
        () => {
          removeExternalConnection(profileId ?? "");
          return { registration: ctx.roster.currentRegistration() };
        },
        externalConnectionFailure,
      );
    })
    .on(daemonMessageTypes.listAgentModels, (envelope, ctx) => {
      const payload = envelope.payload as ListAgentModelsPayload | undefined;
      if (!payload?.profile) {
        sendWebSocket(
          ctx.socket,
          daemonMessageTypes.agentModelsListed,
          { error: "list_agent_models requires profile" },
          envelope.id,
        );
        return;
      }
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.agentModelsListed,
        async () => ({
          models: await listAgentModelsConfig(
            payload.profile,
            ctx.workspacePath,
          ),
        }),
      );
    })
    .on(daemonMessageTypes.readProviderKey, (envelope, ctx) => {
      const payload = envelope.payload as ReadProviderKeyPayload | undefined;
      const profileId = payload?.profileId;
      if (!profileId) {
        sendWebSocket(
          ctx.socket,
          daemonMessageTypes.providerKeyRead,
          { error: "read_provider_key requires profileId" },
          envelope.id,
        );
        return;
      }
      // Answers this one request and nothing else: the key goes straight
      // into the reply envelope for the server's promote flow, and is never
      // written to a log line or held anywhere else.
      return reply(ctx, envelope, daemonMessageTypes.providerKeyRead, () =>
        configuredProviderKey(profileId),
      );
    })
    .on(daemonMessageTypes.upsertAgentProfile, (envelope, ctx) => {
      const payload = envelope.payload as UpsertAgentProfilePayload | undefined;
      if (!payload?.profile) {
        sendWebSocket(
          ctx.socket,
          daemonMessageTypes.agentProfileUpserted,
          { error: "upsert_agent_profile requires profile" },
          envelope.id,
        );
        return;
      }
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.agentProfileUpserted,
        () => {
          const targetWorkspacePath = payload.profile.workspaceId
            ? ctx.roster.folderFor(payload.profile.workspaceId)
            : (ctx.roster.knownPaths().find(workspaceFolderPresent) ?? "");
          const profile = upsertAgentProfileConfig(
            payload.profile,
            targetWorkspacePath,
          );
          const registration = targetWorkspacePath
            ? ctx.roster.registration(targetWorkspacePath)
            : ctx.roster.deviceRegistration();
          if (hasWorkspace(registration)) ctx.roster.register(registration);
          return { profile, registration };
        },
      );
    })
    .on(daemonMessageTypes.upsertAgentRuntimeSettings, (envelope, ctx) => {
      const payload = envelope.payload as
        UpsertAgentRuntimeSettingsPayload | undefined;
      if (!payload?.settings) {
        sendWebSocket(
          ctx.socket,
          daemonMessageTypes.agentRuntimeSettingsUpserted,
          { error: "upsert_agent_runtime_settings requires settings" },
          envelope.id,
        );
        return;
      }
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.agentRuntimeSettingsUpserted,
        () => {
          const settings = writeAgentRuntimeSettings(payload.settings);
          ctx.taskScheduler.setMaxConcurrentTasks(settings.maxConcurrentTasks);
          ctx.announceAdditionalIssueCapacity();
          const registration = ctx.roster.currentRegistration();
          if (hasWorkspace(registration)) ctx.roster.register(registration);
          return { registration, settings };
        },
      );
    });
}

function externalConnectionFailure(message: string, error: unknown) {
  return {
    error: message,
    errorCode:
      error instanceof ExternalConnectionError ? error.code : undefined,
  };
}
