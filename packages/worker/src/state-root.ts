/**
 * Private state for one local stack.
 *
 * The default stack keeps `~/.foundry` so existing installs are untouched.
 * Named stacks live side by side under `~/.foundry-stacks/<name>`, which lets
 * several worktrees run their own server, worker and web at the same time.
 * Both parents are denied to issue executors, so one stack can never read
 * another's private state.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

export const defaultStateRoot = resolve(homedir(), ".foundry");
export const stackStateParent = resolve(homedir(), ".foundry-stacks");

/**
 * A test run (`node --test` marks its processes with NODE_TEST_CONTEXT) must
 * name its own scratch folders: a test once registered its temporary
 * workspaces in a real device's ~/.foundry when run without the test runner.
 */
function refuseRealFolderInTests(variable: string): void {
  if (process.env.NODE_TEST_CONTEXT)
    throw new Error(
      `Tests must set ${variable} to a scratch folder (run them with scripts/run-worker-tests.mjs); refusing the real one.`,
    );
}

export function foundryStateRoot(): string {
  const configured = process.env.FOUNDRY_STATE_ROOT?.trim();
  if (configured) return resolve(configured);
  const stack = process.env.FOUNDRY_STACK?.trim();
  if (stack) return resolve(stackStateParent, stack);
  refuseRealFolderInTests("FOUNDRY_STATE_ROOT");
  return defaultStateRoot;
}

export function foundryStatePath(...segments: string[]): string {
  return resolve(foundryStateRoot(), ...segments);
}

/**
 * Programs Foundry installs for skills (e.g. a bundle's CLI), one folder
 * per tool and version with a `bin` folder of current versions. It sits
 * outside the state root on purpose: sandboxed sessions may run these
 * programs but must never read Foundry's own state.
 */
export function foundryToolsRoot(): string {
  const configured = process.env.FOUNDRY_TOOLS_ROOT?.trim();
  if (configured) return resolve(configured);
  refuseRealFolderInTests("FOUNDRY_TOOLS_ROOT");
  return resolve(homedir(), ".foundry-tools");
}

/** Suffix that keeps launchd labels and log names distinct per stack. */
export function foundryStackSuffix(): string {
  const stack = process.env.FOUNDRY_STACK?.trim();
  return stack ? `.${stack}` : "";
}
