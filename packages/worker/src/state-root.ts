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

export function foundryStateRoot(): string {
  const configured = process.env.FOUNDRY_STATE_ROOT?.trim();
  if (configured) return resolve(configured);
  const stack = process.env.FOUNDRY_STACK?.trim();
  return stack ? resolve(stackStateParent, stack) : defaultStateRoot;
}

export function foundryStatePath(...segments: string[]): string {
  return resolve(foundryStateRoot(), ...segments);
}

/** Suffix that keeps launchd labels and log names distinct per stack. */
export function foundryStackSuffix(): string {
  const stack = process.env.FOUNDRY_STACK?.trim();
  return stack ? `.${stack}` : "";
}
