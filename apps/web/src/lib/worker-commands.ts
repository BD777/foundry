import { type WorkerRelease, workerPackageName } from "@bd777/foundry-protocol";
import { useEffect, useState } from "react";
import { getWorkerRelease, workerServerURL } from "../api";

/** The command a device already set up runs to check or update itself. */
export const localWorkerCommand = "~/.foundry/bin/foundry-worker";

/**
 * The bootstrap for a machine without the local command: pairing a new one,
 * a device set up before the local command existed (worker 0.5.3 and older),
 * or one moving to this server's own worker build. It runs the worker this
 * server names: its own packages through npx, else the npm release.
 */
export function npxWorkerCommand(
  release: WorkerRelease,
  serverURL: string,
): string {
  if (release.source !== "server") return `npx -y ${workerPackageName}@latest`;
  const packages = release.packages.map(
    (pkg) =>
      `--package=${pkg.latestUrl.startsWith("/") ? `${serverURL}${pkg.latestUrl}` : pkg.latestUrl}`,
  );
  return `npx -y --prefer-offline ${packages.join(" ")} foundry-worker`;
}

/**
 * The one command that brings a machine to this server's worker without a
 * local command. For a server build it is `install --server`, which updates
 * the worker paired with this server whichever stack holds it and refuses
 * only a machine not yet paired (that needs Add device's token). The npm
 * release's older workers know only `update`.
 */
export function npxUpdateCommand(
  release: WorkerRelease,
  serverURL: string,
): string {
  const bootstrap = npxWorkerCommand(release, serverURL);
  return release.source === "server"
    ? `${bootstrap} install --server ${serverURL}`
    : `${bootstrap} update`;
}

/** This server's worker release; undefined until loaded. */
export function useWorkerRelease(): {
  release?: WorkerRelease;
  bootstrap?: string;
  update?: string;
  error?: string;
} {
  const [release, setRelease] = useState<WorkerRelease>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    getWorkerRelease()
      .then((loaded) => {
        if (!cancelled) setRelease(loaded);
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return {
    release,
    bootstrap: release
      ? npxWorkerCommand(release, workerServerURL())
      : undefined,
    update: release ? npxUpdateCommand(release, workerServerURL()) : undefined,
    error,
  };
}
