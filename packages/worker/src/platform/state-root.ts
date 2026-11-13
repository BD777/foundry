/**
 * Private state for one local stack.
 *
 * The default stack keeps `~/.foundry` so existing installs are untouched.
 * Named stacks live side by side under `~/.foundry-stacks/<name>`, which lets
 * several worktrees run their own server, worker and web at the same time.
 * Both parents are denied to issue executors, so one stack can never read
 * another's private state.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * This module's package root when it runs from a source checkout: the
 * published package carries only dist (package.json "files"), a checkout
 * also has src and tsconfig.json.
 */
function checkoutPackageRoot(): string | undefined {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return existsSync(join(root, "src")) &&
    existsSync(join(root, "tsconfig.json"))
    ? root
    : undefined;
}

/**
 * Worker code run from a checkout (a script, a repro, a test run without
 * scripts/run-worker-tests.mjs) gets a fresh scratch state root unless it
 * names one or opts in with FOUNDRY_USE_REAL_STATE=1. DEV-217: a benchmark's
 * proxy repro wrote this device's real worker-proxy.json, pointing the
 * Worker at a dead test proxy for three hours. The root is exported so the
 * processes it starts share it.
 */
function checkoutScratchRoot(): string | undefined {
  if (process.env.FOUNDRY_USE_REAL_STATE === "1") return undefined;
  const checkout = checkoutPackageRoot();
  if (!checkout) return undefined;
  const root = mkdtempSync(join(tmpdir(), "foundry-checkout-state-"));
  process.env.FOUNDRY_STATE_ROOT = root;
  process.env.FOUNDRY_TOOLS_ROOT ??= join(root, "tools");
  process.stderr.write(
    `Foundry Worker code from the checkout ${checkout} keeps its state in ${root}, not ${defaultStateRoot}. Set FOUNDRY_STATE_ROOT or FOUNDRY_STACK to choose one, or FOUNDRY_USE_REAL_STATE=1 for this device's own.\n`,
  );
  return root;
}

export function foundryStateRoot(): string {
  const configured = process.env.FOUNDRY_STATE_ROOT?.trim();
  if (configured) return resolve(configured);
  const stack = process.env.FOUNDRY_STACK?.trim();
  if (stack) return resolve(stackStateParent, stack);
  refuseRealFolderInTests("FOUNDRY_STATE_ROOT");
  return checkoutScratchRoot() ?? defaultStateRoot;
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
  if (
    !process.env.FOUNDRY_STATE_ROOT?.trim() &&
    !process.env.FOUNDRY_STACK?.trim() &&
    checkoutScratchRoot()
  )
    return resolve(process.env.FOUNDRY_TOOLS_ROOT!);
  return resolve(homedir(), ".foundry-tools");
}

/** Suffix that keeps launchd labels and log names distinct per stack. */
export function foundryStackSuffix(): string {
  const stack = process.env.FOUNDRY_STACK?.trim();
  return stack ? `.${stack}` : "";
}
