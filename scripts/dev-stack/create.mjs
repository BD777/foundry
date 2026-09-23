// One command from nothing to a verified stack: worktree, dependencies, builds,
// launch agents, running services, diagnosis and a real agent session.

import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  assertIsolatable,
  build,
  defaultStack,
  initWorkspace,
  knownStacks,
  portFree,
  ports,
  providerEnvPath,
  registry,
  repoRoot,
  saveRegistry,
  stackParent,
  start,
  writePlists,
} from "./stack.mjs";
import { doctor, smoke } from "./doctor.mjs";

/**
 * A new stack usually wants its own branch too. Creating the worktree here
 * keeps one command between "nothing" and "a running, verified stack".
 */
function addWorktree(worktree, branch, base) {
  if (existsSync(worktree)) {
    if (!existsSync(resolve(worktree, ".git")))
      throw new Error(`${worktree} exists and is not a Git worktree`);
    return;
  }
  const result = spawnSync(
    "git",
    ["worktree", "add", "-b", branch, worktree, base ?? "HEAD"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.status !== 0)
    throw new Error(`git worktree add ${worktree} (${branch}) failed`);
}

function installProviderEnv(stack, source) {
  const path = providerEnvPath(stack);
  copyFileSync(resolve(source), path);
  chmodSync(path, 0o600);
}

export async function create(name, options) {
  if (!/^[a-z][a-z0-9-]{0,20}$/.test(name) || name === defaultStack.name)
    throw new Error(
      "stack name must match [a-z][a-z0-9-]{0,20} and cannot be 'main'",
    );
  const stacks = knownStacks();
  if (stacks.some((stack) => stack.name === name))
    throw new Error(`stack ${name} already exists`);
  const worktree = resolve(options.worktree ?? process.cwd());
  if (options.branch) addWorktree(worktree, options.branch, options.base);
  if (!existsSync(resolve(worktree, "pnpm-workspace.yaml")))
    throw new Error(`${worktree} is not a Foundry worktree`);
  if (stacks.some((stack) => resolve(stack.worktree ?? "") === worktree))
    throw new Error(`${worktree} already backs another stack`);
  const portBase =
    Number(options.portBase) ||
    Math.max(41000 - 1000, ...stacks.map((stack) => stack.portBase)) + 1000;
  const { server, web } = ports(portBase);
  for (const port of [server, web])
    if (!(await portFree(port))) throw new Error(`port ${port} is in use`);
  const stack = {
    name,
    worktree,
    portBase,
    stateRoot: resolve(stackParent, name),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(resolve(stack.stateRoot, "logs"), { recursive: true, mode: 0o700 });
  if (options.providerEnv) installProviderEnv(stack, options.providerEnv);
  if (!options.noBuild) build(stack);
  assertIsolatable(stack);
  initWorkspace(stack);
  writePlists(stack);
  saveRegistry([...registry(), stack]);
  await start(stack.name);
  console.log(
    [
      `stack ${name} ready`,
      `  worktree   ${worktree}`,
      `  web        http://127.0.0.1:${web}`,
      `  server     http://127.0.0.1:${server}`,
      `  state      ${stack.stateRoot}`,
      `  database   ${resolve(worktree, "apps/server/.data/foundry.db")}`,
    ].join("\n"),
  );
  // Repair what the tool can repair itself, then prove the stack really runs an
  // agent. A create that only started processes is not a usable environment.
  const ready = await doctor(name, { fix: true });
  if (ready && !options.noSmoke) await smoke(name);
  else if (!ready)
    throw new Error(
      `stack ${name} is running but not usable; the doctor report above lists what is left`,
    );
}
