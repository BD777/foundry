/**
 * What a host that is gone leaves in its own root: the envelopes the server
 * has not acknowledged and the inputs it accepted and never finished. The
 * host that serves the device takes them over: it delivers the envelopes
 * and reports the unfinished inputs as interrupted, never as rerun.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { executionHostStoppedError } from "@bd777/foundry-protocol";
import { writePrivateJSONAtomic } from "../platform/storage.js";
import { reportWorkerFailure } from "../session/worker-failure.js";
import { hostWasStopped, liveHostIdentity, readHostIdentity } from "./roots.js";
import { FileSessionOutbox } from "../transport/session-outbox-store.js";
import type { ReliableSessionTransport } from "../transport/transport.js";

type Claims = Record<
  string,
  {
    sessionId: string;
    inputId: string;
    dispatchId?: string;
    status: "active" | "completed";
    completedAt?: string;
  }
>;

export interface Adoption {
  envelopes: number;
  interrupted: number;
}

/** `root` must belong to a host that no longer runs. */
export function adoptStoppedHost(
  root: string,
  transport: Pick<ReliableSessionTransport, "send">,
  options: { removeRoot?: boolean } = {},
): Adoption {
  const result: Adoption = { envelopes: 0, interrupted: 0 };
  const claimsPath = resolve(root, "claims.json");
  if (existsSync(claimsPath)) {
    const claims = JSON.parse(readFileSync(claimsPath, "utf8")) as Claims;
    for (const claim of Object.values(claims))
      if (claim.status === "active") {
        reportWorkerFailure(
          transport,
          {
            id: claim.sessionId,
            dispatchId: claim.dispatchId,
            input: { id: claim.inputId },
          },
          executionHostStoppedError,
        );
        claim.status = "completed";
        claim.completedAt = new Date().toISOString();
        result.interrupted++;
      }
    if (result.interrupted) writePrivateJSONAtomic(claimsPath, claims);
  }
  const outbox = new FileSessionOutbox(resolve(root, "outbox"));
  for (const envelope of outbox.read()) {
    transport.send(envelope.type, envelope.payload, envelope.id);
    outbox.remove(envelope.id!);
    result.envelopes++;
  }
  // The host is gone for good: its record must not pin a runtime any more.
  if (options.removeRoot) rmSync(root, { recursive: true, force: true });
  else rmSync(resolve(root, "identity.json"), { force: true });
  return result;
}

/** How long a dead host without a stop marker is given to come back. */
export const deadHostAdoptionMs = 60_000;

/**
 * Whether the host at `root` is gone for good. One whose service the daemon
 * stopped is. One that merely died is restarted by its service manager within
 * seconds and reports its own leftovers, so it is adopted only if it stays
 * dead; `deadSince` remembers when each root was first seen dead.
 */
export function adoptionDue(
  root: string,
  deadSince: Map<string, number>,
  now = Date.now(),
  graceMs = deadHostAdoptionMs,
): boolean {
  if (liveHostIdentity(root) || !readHostIdentity(root)) {
    deadSince.delete(root);
    return false;
  }
  if (hostWasStopped(root)) return true;
  const since = deadSince.get(root) ?? now;
  deadSince.set(root, since);
  return now - since >= graceMs;
}

/** Inputs the host never finished or envelopes the server never got. */
export function hasUnfinishedWork(root: string): boolean {
  try {
    const claims = JSON.parse(
      readFileSync(resolve(root, "claims.json"), "utf8"),
    ) as Claims;
    if (Object.values(claims).some((claim) => claim.status === "active"))
      return true;
  } catch {
    // No claims were ever written.
  }
  return new FileSessionOutbox(resolve(root, "outbox")).read().length > 0;
}
