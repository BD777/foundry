#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CliError,
  formatCliError,
  genericCliError,
  parseCliInvocation,
  requestedDocumentation,
} from "./cli-contract.js";
import { initWorkspace, listWorkspaces } from "./workspaces.js";
import { installService, status, uninstallService } from "./service.js";
import { doctor, providerHealth } from "./workspace-ops.js";
import { connect, logs, pair, setup, sync } from "./daemon-connection.js";
import { registerExecutionWorkspace } from "./repository-registry.js";
import { readWorkspace } from "./workspaces.js";
import { workspacePathFromArgs } from "./workspace-ops.js";
import { ExecutionStore } from "./execution-storage.js";
import { cleanupEnvironment } from "./issue-environments.js";
import { optionEnabled } from "./utils.js";

const VERSION = "0.0.0";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--") {
    args.shift();
  }

  if (args[0] === "--version" || args[0] === "-v") {
    console.log(VERSION);
    return;
  }

  const documentation = requestedDocumentation(args, VERSION);
  if (documentation !== undefined) {
    console.log(documentation);
    return;
  }

  const invocation = parseCliInvocation(args);
  const commandArgs = args.slice(invocation.command.path.length);
  switch (invocation.command.id) {
    case "workspace-scan": {
      const path = invocation.positionals[0]!;
      console.log(
        JSON.stringify(
          await registerExecutionWorkspace(path, readWorkspace(path).id),
          null,
          2,
        ),
      );
      break;
    }
    case "issue-environment": {
      const workspace = readWorkspace(workspacePathFromArgs(commandArgs));
      const store = new ExecutionStore();
      const issueId = invocation.positionals[0]!;
      await store.lock(workspace.id, `execution-${issueId}`, async () => {
        const environment = store.environment(workspace.id, issueId);
        if (!environment) throw new Error("Issue environment is missing");
        if (optionEnabled(commandArgs, "--cleanup"))
          await cleanupEnvironment(environment, store);
        console.log(JSON.stringify(environment, null, 2));
      });
      break;
    }
    case "setup":
      await setup(commandArgs);
      break;
    case "init":
      initWorkspace(invocation.positionals[0]);
      await registerExecutionWorkspace(
        invocation.positionals[0]!,
        readWorkspace(invocation.positionals[0]!).id,
      );
      break;
    case "connect":
      await connect(commandArgs);
      break;
    case "daemon":
      await connect(commandArgs);
      break;
    case "pair":
      await pair(commandArgs);
      break;
    case "install-service":
      installService(commandArgs);
      break;
    case "status":
      status();
      break;
    case "logs":
      logs(commandArgs);
      break;
    case "uninstall-service":
      uninstallService();
      break;
    case "sync":
      await sync(commandArgs);
      break;
    case "doctor":
      doctor(invocation.positionals[0]);
      break;
    case "providers":
      providerHealth(commandArgs);
      break;
    case "workspace-list":
      listWorkspaces();
      break;
    default:
      throw new Error(`Unsupported command contract: ${invocation.command.id}`);
  }
}

// Only run the CLI when this module is the process entry point. Importing
// cli.ts (e.g. from tests) must not execute main() or print usage.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const args = process.argv.slice(2);
    if (args[0] === "--") {
      args.shift();
    }
    const cliError =
      error instanceof CliError ? error : genericCliError(error, args);
    console.error(formatCliError(cliError));
    process.exit(cliError.exitCode);
  });
}
