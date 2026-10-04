import { workerPackageName } from "@bd777/foundry-protocol";

/** The command a device already set up runs to check or update itself. */
export const localWorkerCommand = "~/.foundry/bin/foundry-worker";

/**
 * The bootstrap for a machine without the local command: pairing a new one,
 * or a device set up before the local command existed (worker 0.5.3 and
 * older), which gets it after one update this way.
 */
export const npxWorkerCommand = `npx -y ${workerPackageName}@latest`;
