#!/usr/bin/env node

/**
 * `foundry` — the command line for people on a device with a paired worker
 * (or a session's token): the same Foundry tools sessions call, from a
 * shell. Every command but `mcp` and `skill` calls one tool on the server's
 * MCP endpoint and prints its answer (foundry-cli-commands.ts).
 *
 *   foundry mcp                 stdio MCP server for agents outside Foundry
 *   foundry session <verb>      read, start, steer and wait on sessions
 *   foundry issue list|get      Issues, read-only
 *   foundry feishu subscribe|events  a connected Feishu app's events
 *   foundry workspace <verb>    find, read, create, change and archive workspaces
 *   foundry assistant <verb>    the assistant's memory, rules, tasks and the person's list
 *   foundry device list         devices, whether online, and what they offer
 *   foundry profile|model list  runnable profiles and their models
 *   foundry skill [name]        print or install a bundled skill
 *
 * Operational worker commands remain on the separate `foundry-worker` bin.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FoundryClient,
  FoundryClientError,
  resolveConfig,
} from "./foundry-client.js";
import {
  foundryCommands,
  foundryCommonFlags,
  foundryConnectionFlags,
  isToolCommand,
  type FlagSpec,
  type ToolCommand,
} from "./foundry-cli-commands.js";
import { runMcpServer } from "./foundry-mcp.js";
import { claudeConfigDir } from "./native-homes.js";
import { errorMessage } from "./utils.js";

/** A command's words after the verb: its positional word and its flags. */
function toolArguments(
  name: string,
  command: ToolCommand,
  words: string[],
): { args: Record<string, unknown>; server?: string } {
  const flags: Record<string, FlagSpec> = {
    ...foundryCommonFlags,
    ...command.flags,
  };
  const args: Record<string, unknown> = { ...command.fixed };
  let server: string | undefined;
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (!word.startsWith("--")) {
      if (!command.positional || args[command.positional] !== undefined)
        throw new FoundryClientError(`foundry ${name} takes no ${word}`);
      args[command.positional] = word;
      continue;
    }
    const value = (): string => {
      const next = words[++index];
      if (next === undefined)
        throw new FoundryClientError(`${word} needs a value`);
      return next;
    };
    if (foundryConnectionFlags.includes(word)) {
      server = value();
      continue;
    }
    const spec = flags[word];
    if (!spec)
      throw new FoundryClientError(
        `foundry ${name} reads no ${word} (it reads ${Object.keys(flags).join(", ")})`,
      );
    const [target, key] = flagTarget(args, spec);
    switch (spec.kind) {
      case "boolean":
        if (spec.adds) appendList(target, key, spec.adds);
        else target[key] = true;
        break;
      case "number": {
        const number = Number(value());
        if (!Number.isInteger(number) || number <= 0)
          throw new FoundryClientError(`${word} needs a positive whole number`);
        target[key] = number;
        break;
      }
      case "list":
        appendList(target, key, value().split(","));
        break;
      case "file":
        target[key] = readFileSync(value(), "utf8");
        break;
      case "json": {
        const text = value();
        try {
          target[key] = JSON.parse(text);
        } catch {
          throw new FoundryClientError(`${word} needs JSON, got ${text}`);
        }
        break;
      }
      case "jsonFile": {
        // Large arguments (an upload's piece) exceed a command line's limit.
        const path = value();
        try {
          target[key] = JSON.parse(readFileSync(path, "utf8"));
        } catch (error) {
          throw new FoundryClientError(
            `${word} needs a file of JSON: ${errorMessage(error)}`,
          );
        }
        break;
      }
      default:
        target[key] = value();
    }
  }
  if (command.positional && args[command.positional] === undefined)
    throw new FoundryClientError(
      `foundry ${name} needs <${command.positional}>`,
    );
  return { args, server };
}

/** The object and key a flag sets: the argument, or a field of it. */
function flagTarget(
  args: Record<string, unknown>,
  spec: FlagSpec,
): [Record<string, unknown>, string] {
  if (!spec.field) return [args, spec.argument];
  const object = (args[spec.argument] ??= {}) as Record<string, unknown>;
  return [object, spec.field];
}

function appendList(
  args: Record<string, unknown>,
  argument: string,
  values: string[],
): void {
  const list = (args[argument] as string[] | undefined) ?? [];
  for (const value of values.map((item) => item.trim()))
    if (value && !list.includes(value)) list.push(value);
  args[argument] = list;
}

async function runToolCommand(
  name: string,
  command: ToolCommand,
  words: string[],
): Promise<void> {
  const { args, server } = toolArguments(name, command, words);
  const client = new FoundryClient(resolveConfig({ serverURL: server }));
  console.log(await client.callTool(command.tool, args));
}

/** The skills shipped in this package's skills/ folder. */
function bundledSkillsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const root of [
    resolve(here, "..", "skills"),
    resolve(here, "..", "..", "skills"),
  ]) {
    try {
      readdirSync(root);
      return root;
    } catch {
      // try next
    }
  }
  throw new FoundryClientError("bundled skills folder is missing");
}

function bundledSkillDirectory(name: string): string {
  const directory = join(bundledSkillsRoot(), name);
  try {
    readFileSync(join(directory, "SKILL.md"));
    return directory;
  } catch {
    throw new FoundryClientError(
      `no bundled skill ${name} (see: foundry skill list)`,
    );
  }
}

/** Copies a skill folder, its references included, over the target. */
function copySkillFiles(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copySkillFiles(from, to);
    else writeFileSync(to, readFileSync(from));
  }
}

/**
 * `foundry skill` prints the foundry skill; `list`, `<name>` and
 * `install <name> [--dir <skills folder>]` cover every bundled skill, so a
 * session started outside Foundry can have them too.
 */
function runSkillCommand(args: string[]): void {
  const [verb, name] = args;
  if (verb === "list") {
    console.log(readdirSync(bundledSkillsRoot()).sort().join("\n"));
    return;
  }
  if (verb === "install") {
    if (!name) throw new FoundryClientError("usage: skill install <name>");
    const source = bundledSkillDirectory(name);
    const dir = args.indexOf("--dir");
    const root =
      dir >= 0 && args[dir + 1]
        ? args[dir + 1]!
        : join(claudeConfigDir(), "skills");
    const target = join(root, name);
    copySkillFiles(source, target);
    console.log(`installed ${name} at ${join(target, "SKILL.md")}`);
    return;
  }
  process.stdout.write(
    readFileSync(join(bundledSkillDirectory(verb ?? "foundry"), "SKILL.md")),
  );
}

function usage(): string {
  const lines = [
    "foundry — the Foundry tools from a shell",
    "",
    "Usage:",
    "  foundry mcp",
  ];
  for (const [command, verbs] of Object.entries(foundryCommands)) {
    for (const [verb, spec] of Object.entries(verbs)) {
      if (!isToolCommand(spec)) continue;
      const words = [`foundry ${command} ${verb}`];
      if (spec.positional) words.push(`<${spec.positional}>`);
      const flags = Object.entries(spec.flags).map(([flag, { kind }]) =>
        kind === "boolean"
          ? flag
          : `${flag} <${kind === "file" || kind === "jsonFile" ? "path" : kind}>`,
      );
      lines.push(
        `  ${words.join(" ")}${flags.length ? ` [${flags.join(" ")}]` : ""}   (${spec.tool})`,
      );
    }
  }
  lines.push(
    "  foundry skill [list | <name> | install <name> [--dir <skills folder>]]",
    "",
    "Every tool command also reads --workspace <id> and --server <url>; each prints the tool's answer.",
    "Credentials are read from FOUNDRY_SESSION_TOKEN or the local paired daemon config.",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(usage() + "\n");
    return;
  }
  if (command === "mcp") {
    await runMcpServer();
    return;
  }
  if (command === "skill") {
    runSkillCommand(rest);
    return;
  }
  const verbs = foundryCommands[command];
  const [verb = "", ...words] = rest;
  const spec = verbs?.[verb];
  if (!spec || !isToolCommand(spec)) {
    process.stderr.write(
      (verbs
        ? `unknown verb: foundry ${command} ${verb} (expected one of ${Object.keys(verbs).join(", ")})\n\n`
        : "") +
        usage() +
        "\n",
    );
    process.exitCode = 2;
    return;
  }
  await runToolCommand(`${command} ${verb}`, spec, words);
}

main().catch((error: unknown) => {
  const message = errorMessage(error);
  process.stderr.write(`foundry: ${message}\n`);
  process.exitCode = 1;
});
