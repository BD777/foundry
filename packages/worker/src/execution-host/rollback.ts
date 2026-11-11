/**
 * Going back to a Worker that predates host rollover. That Worker knows only
 * the original root: with a host of a newer runtime still running beside it
 * it would start a second host, and two hosts then own the device's timers
 * and session work. The newer Worker therefore refuses to install an older
 * build while any host runs outside the original root, unless the person
 * accepts that those hosts (and the turns in them) are stopped first.
 */
import { executionHostPaths } from "./paths.js";
import { knownHostRoots, liveHostIdentity } from "./roots.js";

function parts(version: string): number[] | undefined {
  const numbers = version.split(/[-+]/)[0]!.split(".").map(Number);
  return numbers.length && numbers.every(Number.isInteger)
    ? numbers
    : undefined;
}

/** True only when both versions parse and `target` is the lower one. */
export function isDowngrade(target: string, current: string): boolean {
  const a = parts(target);
  const b = parts(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference < 0;
  }
  return false;
}

export const stopHostsForDowngradeVariable = "FOUNDRY_STOP_HOSTS_FOR_DOWNGRADE";

/** Why installing `target` over `current` is unsafe now, or undefined. */
export function downgradeBlocker(
  target: string,
  current: string,
  roots = knownHostRoots(),
  original = executionHostPaths().root,
): string | undefined {
  if (!isDowngrade(target, current)) return undefined;
  const beside = roots.filter(
    (root) => root !== original && liveHostIdentity(root),
  );
  if (!beside.length) return undefined;
  return (
    `Installing ${target} over ${current} goes back to a Worker that runs one execution host. ` +
    `${beside.length} execution host(s) of newer runtimes still run beside the original one, and the older Worker would start another next to them: ` +
    `two hosts would then both deliver timers and own session work. ` +
    `Wait until the running turns end and the extra hosts have stopped, or set ${stopHostsForDowngradeVariable}=1 to stop all execution hosts now ` +
    `(turns running in them are interrupted and reported as such).`
  );
}
