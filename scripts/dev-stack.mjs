#!/usr/bin/env node
// Runs several Foundry stacks side by side: one worktree, one server, one
// worker and one web per stack, each with its own ports, database and private
// state root. The default stack keeps the plain `dev.foundry.*` labels and
// `~/.foundry`; named stacks live under `~/.foundry-stacks/<name>`.
//
// Primitives live in scripts/dev-stack/stack.mjs, the check-and-repair
// catalogue in scripts/dev-stack/doctor.mjs, and `create` in create.mjs.

import {
  remove,
  start,
  stackParent,
  status,
  stop,
} from "./dev-stack/stack.mjs";
import { doctor, smoke } from "./dev-stack/doctor.mjs";
import { create } from "./dev-stack/create.mjs";

const [command, name, ...rest] = process.argv.slice(2);

function value(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const options = {
  worktree: value(rest, "--worktree"),
  branch: value(rest, "--branch"),
  base: value(rest, "--base"),
  portBase: value(rest, "--port-base"),
  providerEnv: value(rest, "--provider-env"),
  noBuild: rest.includes("--no-build"),
  noSmoke: rest.includes("--no-smoke"),
  purgeState: rest.includes("--purge-state"),
  json: rest.includes("--json"),
  fix: rest.includes("--fix"),
};

const usage = [
  "usage: node scripts/dev-stack.mjs <command>",
  "  list                                  every stack with ports and pids",
  "  create <name> [--worktree PATH]       worktree, build, services, start,",
  "                [--branch NAME [--base REF]]  fix, and a real agent smoke",
  "                [--port-base 42000] [--no-build] [--no-smoke]",
  "                [--provider-env FILE]",
  "  doctor <name> [--fix] [--json]        every known failure, with its fix",
  "  fix <name> [--json]                   doctor that repairs what it can",
  "  smoke <name>                          one real agent session end to end",
  "  start|restart|stop <name>             control one stack",
  "  remove <name> [--purge-state]         drop services and registry entry",
  "",
  "Ports derive from the base: server = base + 982, web = base + 983.",
  "Each stack keeps its own database and private state in its state root",
  `root (${stackParent}/<name>); the default stack stays on ~/.foundry.`,
  "A stack whose provider secret is not in the device profile file can export",
  "it from <state root>/provider-env (mode 0600); start rewrites the launch",
  "agents, so that file is picked up on the next restart.",
  "",
  "`doctor --json` prints {stack, ready, applied, checks[]} for agents and CI.",
].join("\n");

try {
  if (command === "list" || command === "status") status();
  else if (command === "create") await create(name, options);
  else if (command === "start" || command === "restart") await start(name);
  else if (command === "stop") stop(name);
  else if (command === "remove") remove(name, options);
  else if (command === "doctor")
    process.exitCode = (await doctor(name, options)) ? 0 : 1;
  else if (command === "fix")
    process.exitCode = (await doctor(name, { ...options, fix: true })) ? 0 : 1;
  else if (command === "smoke") await smoke(name);
  else {
    console.log(usage);
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
