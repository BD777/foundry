#!/usr/bin/env node

import { redactSecrets } from "./secret-redaction.js";
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
import { connect } from "./daemon-connection.js";
import { logs, pair, setup } from "./daemon/cli-commands.js";
import { registerExecutionWorkspace } from "./repository-registry.js";
import { readWorkspace } from "./workspaces.js";
import { workspacePathFromArgs } from "./workspace-ops.js";
import { ExecutionStore } from "./execution-storage.js";
import { cleanupEnvironment } from "./issue-environments.js";
import { optionEnabled, optionValue } from "./utils.js";
import {
  ownPackage,
  installCommand,
  uninstallCommand,
  updateCommand,
} from "./worker-install.js";
import { checkCodexBuildsWith } from "./agent-runtime/adapters.js";
import { verifyCodexCompatibility } from "./runner/codex-compatibility.js";

checkCodexBuildsWith(verifyCodexCompatibility);

const VERSION = ownPackage().version;

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
    case "proxy-set": {
      const { setWorkerProxy } = await import("./server-proxy.js");
      setWorkerProxy(
        invocation.positionals[0]!,
        optionValue(commandArgs, "--no-proxy"),
      );
      console.log(
        "Worker proxy saved. The daemon reconnects automatically; running agents continue.",
      );
      break;
    }
    case "proxy-clear": {
      const { clearWorkerProxy } = await import("./server-proxy.js");
      clearWorkerProxy();
      console.log(
        "Worker proxy setting cleared; environment fallback applies. The daemon reconnects automatically.",
      );
      break;
    }
    case "proxy-show": {
      const { resolveServerProxy, describeProxy } =
        await import("./server-proxy.js");
      const { readDaemonConfig } = await import("./config.js");
      const result = resolveServerProxy(
        readDaemonConfig()?.serverURL ?? "https://foundry.invalid",
      );
      console.log(
        JSON.stringify({
          proxy: result.url ? describeProxy(result.url) : "direct",
          source: result.source,
          noProxy: result.noProxy,
        }),
      );
      break;
    }
    case "connection-check": {
      const { checkExternalConnection } = await import("./provider-check.js");
      const result = await externalConnectionCommand(() =>
        checkExternalConnection(invocation.positionals[0]!),
      );
      if (!result) break;
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "passed") process.exitCode = 1;
      break;
    }
    case "connection-add": {
      const { addExternalConnection } =
        await import("./external-connection-registry.js");
      const result = await externalConnectionCommand(async () =>
        addExternalConnection({
          id: invocation.positionals[0]!,
          label: optionValue(commandArgs, "--label") ?? "",
          executable: optionValue(commandArgs, "--executable") ?? "",
          args: optionValues(commandArgs, "--arg"),
          identity: optionValue(commandArgs, "--identity") ?? "",
          model: optionValue(commandArgs, "--model") ?? "",
          models: (optionValue(commandArgs, "--models") ?? "")
            .split(",")
            .filter((item) => item.trim()),
          setupCommand: optionValue(commandArgs, "--setup-command"),
          setupUrl: optionValue(commandArgs, "--setup-url"),
          signIn: optionValue(commandArgs, "--sign-in"),
        }),
      );
      if (result) console.log(JSON.stringify(result));
      break;
    }
    case "connection-progress": {
      const { reportSetupProgress } =
        await import("./external-connection-setup.js");
      const result = await externalConnectionCommand(async () =>
        reportSetupProgress({
          id: invocation.positionals[0]!,
          state: optionValue(commandArgs, "--state") ?? "",
          signInUrl: optionValue(commandArgs, "--sign-in-url"),
          userCode: optionValue(commandArgs, "--user-code"),
          message: optionValue(commandArgs, "--message"),
        }),
      );
      if (result) console.log(JSON.stringify({ ok: true, progress: result }));
      break;
    }
    case "connection-remove": {
      const { removeExternalConnection } =
        await import("./external-connection-registry.js");
      const result = await externalConnectionCommand(async () =>
        removeExternalConnection(invocation.positionals[0]!),
      );
      if (result) console.log(JSON.stringify(result));
      break;
    }
    case "connection-list": {
      const { listExternalConnections } =
        await import("./external-connection-registry.js");
      const connections = listExternalConnections();
      if (optionEnabled(commandArgs, "--json")) {
        console.log(JSON.stringify(connections));
        break;
      }
      for (const item of connections)
        console.log(
          [
            item.id,
            item.helperAvailable ? item.check.status : "helper_missing",
            item.model ?? "",
            item.label,
          ].join("\t"),
        );
      break;
    }
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
    case "install":
      await installCommand(commandArgs);
      break;
    case "update":
      await updateCommand(commandArgs);
      break;
    case "uninstall":
      await uninstallCommand(commandArgs);
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
    case "doctor": {
      doctor(invocation.positionals[0]);
      const { readDaemonConfig } = await import("./config.js");
      const { checkServerProxy } = await import("./server-proxy.js");
      const serverURL = readDaemonConfig()?.serverURL;
      if (serverURL) {
        try {
          const result = await checkServerProxy(serverURL);
          console.log(
            `OK  server via ${result.proxy}, ${result.ms}ms (HTTP ${result.status})`,
          );
        } catch (error) {
          console.error(
            `ERR ${error instanceof Error ? error.message : "proxy health check failed"}`,
          );
          process.exitCode = 1;
        }
      }
      break;
    }
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

/** Every value of a repeatable option, in order. */
function optionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === name && index + 1 < args.length) values.push(args[++index]!);
    else if (arg.startsWith(`${name}=`))
      values.push(arg.slice(name.length + 1));
  }
  return values;
}

/**
 * Installers read the outcome from stdout: a refusal is one JSON line with
 * its code, and the exit status follows the documented contract.
 */
async function externalConnectionCommand<T>(
  run: () => Promise<T>,
): Promise<T | undefined> {
  const { ExternalConnectionError } =
    await import("./external-connection-registry.js");
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ExternalConnectionError)) throw error;
    console.log(
      JSON.stringify({ ok: false, code: error.code, error: error.message }),
    );
    console.error(error.message);
    process.exitCode = error.exitCode;
    return undefined;
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
    let output = formatCliError(cliError);
    const proxyValues: string[] = [];
    if (args[0] === "proxy" && args[1] === "set") {
      proxyValues.push(
        ...args
          .slice(2)
          .filter((value) => value.includes("@") || value.includes("://")),
      );
    }
    if (args[0] === "proxy" && args[1] === "set" && args[2])
      proxyValues.push(args[2]);
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--proxy" && args[index + 1])
        proxyValues.push(args[index + 1]!);
      else if (args[index]?.startsWith("--proxy="))
        proxyValues.push(args[index]!.slice(8));
    }
    // Even malformed URLs (unescaped slashes/whitespace in passwords) must not
    // leak through the CLI's echoed invocation or argument validation errors.
    for (const value of proxyValues.filter(Boolean)) {
      output = output.split(JSON.stringify(value)).join('"[redacted proxy]"');
      output = output.split(value).join("[redacted proxy]");
    }
    console.error(redactSecrets(output));
    process.exit(cliError.exitCode);
  });
}
