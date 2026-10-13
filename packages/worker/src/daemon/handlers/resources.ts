import {
  cuaDriverBackend,
  daemonMessageTypes,
  type ResourceBackendInstallRequest,
  type ResourceBackendInstallResult,
  type ResourceOperateRequest,
  type ResourceOperateResult,
  type ResourceResetRequest,
  type ResourceResetResult,
  type ResourceSourceSettings,
} from "@bd777/foundry-protocol";
import { withManagedTools } from "../../managed-tools.js";
import {
  createComputeProvider,
  createCuaDriverProvider,
  cuaDriverScreenControlDetector,
  installResourceBackend,
  isCuaDriverSettingsPane,
  openCuaDriverSettings,
  ProviderRegistry,
  requestCuaDriverAccess,
  requestResourceAccess,
  resourceSettings,
  ResourceOperations,
  ResourceScanner,
} from "../../resources/index.js";
import { foundryTokenEnvName } from "../../session-ambient.js";
import { trySendWebSocket } from "../../transport.js";
import type { DaemonContext } from "../context.js";
import { reply, type DaemonDispatch } from "../dispatch.js";
import { errorMessage } from "../../utils.js";

/**
 * The device's resource inventory; it outlives connections, and reports
 * through whichever one a server that takes it accepted (resources_v1).
 */
const resourceScanner = new ResourceScanner();

/**
 * Asks the person at this device for access: cua-driver's grant run
 * ("cua-driver"), one of its System Settings panes ("cua-driver:<pane>"),
 * or the worker's own grants. cua-driver's grants are then watched live:
 * each change re-runs only its detector, reported at once. Returns what
 * was opened.
 */
async function requestAccessOnDevice(requested: string): Promise<string[]> {
  if (!requested) return [];
  const recheckCuaDriver = () =>
    void resourceScanner.scanOne(cuaDriverScreenControlDetector.id);
  if (requested === cuaDriverBackend)
    return requestCuaDriverAccess({
      onDone: recheckCuaDriver,
      onChange: recheckCuaDriver,
    });
  if (requested.startsWith(`${cuaDriverBackend}:`)) {
    const pane = requested.slice(cuaDriverBackend.length + 1);
    if (!isCuaDriverSettingsPane(pane))
      throw new Error(`unknown System Settings pane for cua-driver: ${pane}`);
    return openCuaDriverSettings(pane, { onChange: recheckCuaDriver });
  }
  return requestResourceAccess(requested);
}

/**
 * Folders of the workspaces the current connection serves: compute works in
 * one only when the server names it and this worker serves it.
 */
let servedWorkspacePaths: () => string[] = () => [];
/**
 * Compute (commands a session of this device's owner runs here, only while
 * the owner allows remote commands): in the environment sessions get,
 * without a Foundry token.
 */
const computeProvider = createComputeProvider({
  workspacePaths: () => servedWorkspacePaths(),
  env: () => {
    const { [foundryTokenEnvName]: _token, ...env } = process.env;
    return { ...env, PATH: withManagedTools(env.PATH) };
  },
});
/**
 * Operations on resources sessions lease (resource_operate): the device
 * side of lease fencing and the open provider sessions. Closed whenever the
 * connection is, so a lease never outlives the server's view of it.
 */
const resourceOperations = new ResourceOperations({
  providers: new ProviderRegistry([createCuaDriverProvider(), computeProvider]),
});

/**
 * A registered connection's workspaces are those compute may work in; a
 * server that keeps the resource inventory hears it now and whenever it
 * changes.
 */
export function serveResources(
  ctx: DaemonContext,
  reportInventory: boolean,
): void {
  servedWorkspacePaths = () => ctx.roster.folders();
  if (reportInventory)
    resourceScanner.attach({
      send: (report) =>
        trySendWebSocket(
          ctx.socket,
          daemonMessageTypes.resourcesReport,
          report,
        ),
      workspacePaths: () => ctx.roster.folders(),
    });
}

/** A closed connection reports nothing and holds no lease open. */
export function stopServingResources(): void {
  resourceScanner.detach();
  void resourceOperations.closeAll();
}

/** The device's resources: access, leased operations, settings, backends. */
export function registerResourceHandlers(dispatch: DaemonDispatch): void {
  dispatch
    .on(daemonMessageTypes.refreshResources, (envelope, ctx) => {
      const payload = envelope.payload as
        { requestAccess?: string } | undefined;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.resourcesRefreshed,
        async () => {
          const opened = await requestAccessOnDevice(
            payload?.requestAccess ?? "",
          );
          // The inventory is detected again too; it reports on its own.
          void resourceScanner.scanAll();
          const registration = ctx.roster.currentRegistration();
          return {
            registration,
            resources: registration.device.resources ?? [],
            opened,
          };
        },
      );
    })
    .on(daemonMessageTypes.resourceOperate, (envelope, ctx) =>
      reply(
        ctx,
        envelope,
        daemonMessageTypes.resourceOperated,
        () =>
          resourceOperations.operate(
            envelope.payload as ResourceOperateRequest,
          ),
        (message): ResourceOperateResult => ({
          results: [],
          error: message,
          errorCode: "backend_error",
        }),
      ),
    )
    .on(daemonMessageTypes.resourceReset, (envelope, ctx) => {
      const payload = envelope.payload as ResourceResetRequest;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.resourceResetDone,
        () => resourceOperations.reset(payload),
        (message): ResourceResetResult => ({
          resourceId: payload?.resourceId ?? "",
          generation: payload?.generation ?? 0,
          error: message,
        }),
      );
    })
    .on(daemonMessageTypes.resourceSettings, async (envelope, ctx) => {
      const applied = resourceSettings.set(
        envelope.payload as Partial<ResourceSourceSettings> | undefined,
      );
      // Off means off at once, whatever the server does next.
      if (!applied.allowRemoteCommands) await computeProvider.stopAll();
      void resourceScanner.scanAll();
      trySendWebSocket(
        ctx.socket,
        daemonMessageTypes.resourceSettingsApplied,
        applied,
        envelope.id,
      );
    })
    .on(daemonMessageTypes.installResourceBackend, async (envelope, ctx) => {
      const payload = envelope.payload as ResourceBackendInstallRequest;
      let result: ResourceBackendInstallResult;
      try {
        result = await installResourceBackend(payload);
      } catch (error) {
        result = {
          backend: payload?.backend ?? "",
          ok: false,
          error: errorMessage(error),
        };
      }
      // The inventory is detected again; it reports on its own.
      void resourceScanner.scanAll();
      trySendWebSocket(
        ctx.socket,
        daemonMessageTypes.resourceBackendInstalled,
        result,
        envelope.id,
      );
    });
}
