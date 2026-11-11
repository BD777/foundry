// Devices and the worker each runs: its build, updates, connections and
// diagnostics.
export type {
  AgentRuntimeSettings,
  DeviceDiagnostics,
  DeviceDisconnect,
  DeviceProjection,
  DeviceRepairAction,
  DeviceRepairResult,
  DeviceResourceSignals,
  DeviceRunner,
  DeviceRunnerDetail,
  DeviceRunnerTurn,
  DeviceServiceState,
  DeviceSystem,
  DeviceWorker,
  DeviceWorkerUpdate,
  DeviceTurnEstimate,
  DeviceRuntimeState,
  DiagnosticCheck,
  DiagnosticStatus,
  WorkerConnectionReport,
  WorkerOutboxPeak,
  WorkerSentAfterOpen,
  WorkerSentCount,
  WorkerStall,
  WorkerUpdateFailureCode,
  WorkerUpdateStep,
} from "./contract.gen.js";

/**
 * The npm package that installs a worker: `npx -y <name>@latest install`.
 * The web shows its commands; the worker installs and updates itself from it.
 */
export const workerPackageName = "@bd777/foundry-worker";

/**
 * Where a server's worker comes from (`GET /api/worker/release`): package
 * tarballs the server serves itself, at server-relative URLs, or the npm
 * registry. Workers install and update from it; the web shows commands for it.
 */
export type WorkerRelease =
  | { source: "npm" }
  | {
      source: "server";
      version: string;
      /**
       * `url` names this exact build (workers install from it); `latestUrl`
       * always serves the current one, so commands naming it stay valid.
       */
      packages: { name: string; url: string; latestUrl: string }[];
    };
