#!/usr/bin/env node

/**
 * `foundry` — the human/agent entry point shipped with @bd777/foundry-worker.
 *
 *   foundry mcp                 stdio MCP server for agents
 *   foundry session <verb>      JSON-first session control for people/scripts
 *   foundry workspace list      workspaces this credential reaches
 *   foundry device list         devices, whether online, and what they offer
 *   foundry profile list        list runnable profiles on this device
 *   foundry skill [name]        print or install a bundled skill
 *
 * Operational worker commands remain on the separate `foundry-worker` bin.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FoundryClient,
  FoundryClientError,
  resolveConfig,
} from "./foundry-client.js";
import { runMcpServer } from "./foundry-mcp.js";

function print(value: unknown): void {
  if (typeof value === "string") {
    console.log(value);
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function present(args: string[], name: string): boolean {
  return args.includes(name);
}

/** A positive whole number flag, or undefined when absent. */
function numberFlag(args: string[], name: string): number | undefined {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new FoundryClientError(`${name} needs a positive whole number`);
  }
  return value;
}

function listFlag(args: string[], name: string): string[] {
  const values: string[] = [];
  args.forEach((arg, index) => {
    if (arg === name && args[index + 1] !== undefined) {
      values.push(...args[index + 1]!.split(","));
    }
  });
  return values.map((value) => value.trim()).filter(Boolean);
}

/** `session events` flags as read_context scope=events arguments. */
function eventArguments(args: string[]): Record<string, unknown> {
  const levels = listFlag(args, "--level");
  if (present(args, "--errors")) levels.push("error", "warning");
  const labels = listFlag(args, "--label");
  const values: Record<string, unknown> = {
    sessionId: requireId(args),
    scope: "events",
    levels: levels.length ? [...new Set(levels)] : undefined,
    labels: labels.length ? labels : undefined,
    query: flag(args, "--query"),
    tail: numberFlag(args, "--tail"),
    limit: numberFlag(args, "--limit"),
    context: numberFlag(args, "--context"),
    after: flag(args, "--after"),
    before: flag(args, "--before"),
    maxBytes: numberFlag(args, "--max-bytes"),
  };
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

function client(args: string[]): FoundryClient {
  return new FoundryClient(
    resolveConfig({
      serverURL: flag(args, "--server"),
      workspaceId: flag(args, "--workspace"),
      sessionId: flag(args, "--session"),
    }),
  );
}

const SESSION_VERBS = new Set([
  "list",
  "children",
  "get",
  "events",
  "thread",
  "chat",
  "subagents",
  "create",
  "handoff",
  "send",
  "cancel",
  "wait",
  "rename",
  "groups",
  "group",
]);

async function runSessionCommand(args: string[]): Promise<void> {
  const verb = args[0];
  const rest = args.slice(1);
  const foundry = client(rest);
  switch (verb) {
    case "list":
      print(await foundry.listSessions());
      return;
    case "children": {
      const parent = rest[0] ?? resolveConfig().sessionId;
      if (!parent)
        throw new FoundryClientError("parent session id is required");
      print(await foundry.listChildren(parent));
      return;
    }
    case "get":
      print(
        await foundry.callTool("get_session", { sessionId: requireId(rest) }),
      );
      return;
    case "events":
      print(await foundry.callTool("read_context", eventArguments(rest)));
      return;
    case "thread":
      print(await foundry.getThread(requireId(rest)));
      return;
    case "chat":
      print(await foundry.getChat(requireId(rest)));
      return;
    case "subagents":
      print(await foundry.listSubagents(requireId(rest)));
      return;
    case "create": {
      const prompt = flag(rest, "--prompt");
      const promptFile = flag(rest, "--prompt-file");
      const brief =
        prompt ?? (promptFile ? readFileSync(promptFile, "utf8") : "");
      if (!brief.trim()) {
        throw new FoundryClientError(
          "provide a brief with --prompt or --prompt-file",
        );
      }
      const session = await foundry.createSession({
        prompt: brief,
        profileId: flag(rest, "--profile"),
        provider: flag(rest, "--provider"),
        model: flag(rest, "--model"),
        importedContext: flag(rest, "--context"),
        issueId: flag(rest, "--issue"),
        forkSessionId: flag(rest, "--fork"),
        verification: present(rest, "--verification"),
        claudeEffort: flag(rest, "--claude-effort"),
        claudePermissionMode: flag(rest, "--claude-permission-mode"),
        codexReasoningEffort: flag(rest, "--codex-reasoning-effort"),
        codexSandboxMode: flag(rest, "--codex-sandbox-mode"),
        codexApprovalPolicy: flag(rest, "--codex-approval-policy"),
        codexSpeed: flag(rest, "--codex-speed"),
      });
      if (present(rest, "--wait")) {
        print(
          await foundry.waitFor(
            session.id,
            ["completed", "failed", "canceled"],
            Number(flag(rest, "--timeout-ms") ?? 600_000),
          ),
        );
      } else {
        print(session);
      }
      return;
    }
    case "handoff": {
      const from = rest[0];
      const promptFile = flag(rest, "--prompt-file");
      const prompt =
        flag(rest, "--message") ??
        flag(rest, "--prompt") ??
        (promptFile ? readFileSync(promptFile, "utf8") : "");
      if (!from || !prompt) {
        throw new FoundryClientError(
          "usage: handoff <fromSessionId> --message <text>",
        );
      }
      print(
        await foundry.handoffSession({
          fromSessionId: from,
          prompt,
          profileId: flag(rest, "--profile"),
          issueId: flag(rest, "--issue"),
        }),
      );
      return;
    }
    case "send": {
      const id = rest[0];
      const message = flag(rest, "--message") ?? flag(rest, "--prompt");
      if (!id || !message) {
        throw new FoundryClientError(
          "usage: send <sessionId> --message <text>",
        );
      }
      print(await foundry.send(id, message));
      return;
    }
    case "cancel":
      print(await foundry.cancel(requireId(rest)));
      return;
    case "wait": {
      const id = rest[0];
      if (!id) throw new FoundryClientError("session id is required");
      const until = (flag(rest, "--until") ?? "completed,failed,canceled")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      print(
        await foundry.waitFor(
          id,
          until,
          Number(flag(rest, "--timeout-ms") ?? 600_000),
        ),
      );
      return;
    }
    case "rename": {
      const id = rest[0];
      const title = flag(rest, "--title");
      if (!id || !title) {
        throw new FoundryClientError(
          "usage: rename <sessionId> --title <text>",
        );
      }
      print(await foundry.rename(id, title));
      return;
    }
    case "groups":
      print((await foundry.getLayout()).groups);
      return;
    case "group": {
      const groupId = rest[0];
      if (!groupId) throw new FoundryClientError("group id is required");
      print(await foundry.listGroupSessions(groupId));
      return;
    }
    default:
      throw new FoundryClientError(
        `unknown session verb: ${verb ?? ""} (expected one of ${[...SESSION_VERBS].join(", ")})`,
      );
  }
}

function requireId(args: string[]): string {
  const id = args[0];
  if (!id || id.startsWith("--")) {
    throw new FoundryClientError("session id or Foundry chat link is required");
  }
  return id;
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

function bundledSkill(name: string): string {
  try {
    return readFileSync(join(bundledSkillsRoot(), name, "SKILL.md"), "utf8");
  } catch {
    throw new FoundryClientError(
      `no bundled skill ${name} (see: foundry skill list)`,
    );
  }
}

/**
 * `foundry skill` prints the orchestrator skill; `list`, `<name>` and
 * `install <name> [--dir <skills folder>]` cover every bundled skill, so a
 * session started outside Foundry can have them too.
 */
function runSkillCommand(args: string[]): void {
  const [verb, name] = args;
  if (verb === "list") {
    print(readdirSync(bundledSkillsRoot()).sort().join("\n"));
    return;
  }
  if (verb === "install") {
    if (!name) throw new FoundryClientError("usage: skill install <name>");
    const content = bundledSkill(name);
    const root = flag(args, "--dir") ?? join(homedir(), ".claude", "skills");
    const target = join(root, name, "SKILL.md");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    print(`installed ${name} at ${target}`);
    return;
  }
  process.stdout.write(bundledSkill(verb ?? "foundry-orchestrator"));
}

function usage(): string {
  return [
    "foundry — manage Foundry sessions from a device",
    "",
    "Usage:",
    "  foundry mcp",
    "  foundry session list|children|get|events|thread|chat|subagents|create|handoff|send|cancel|wait|rename|groups|group [flags]",
    "  foundry session get <id|link>",
    "  foundry session events <id|link> [--errors] [--level error,warning] [--label <label>] [--query <text>]",
    "                         [--tail N | --limit N] [--context N] [--after <cursor>] [--before <cursor>] [--max-bytes N]",
    "  foundry workspace list",
    "  foundry device list",
    "  foundry profile list",
    "  foundry skill [list | <name> | install <name> [--dir <skills folder>]]",
    "",
    "Common flags: --workspace <id>  --server <url>  --session <id>",
    "Credentials are read from FOUNDRY_SESSION_TOKEN or the local paired daemon config.",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);
  switch (command) {
    case "mcp":
      await runMcpServer();
      return;
    case "session":
      await runSessionCommand(rest);
      return;
    case "profile":
      if (rest[0] === "list") {
        print(
          await client(rest.slice(1)).listProfiles(flag(rest, "--runtime")),
        );
        return;
      }
      break;
    case "workspace":
      if (rest[0] === "list") {
        print(await client(rest.slice(1)).callTool("list_workspaces", {}));
        return;
      }
      break;
    case "device":
      if (rest[0] === "list") {
        print(await client(rest.slice(1)).callTool("list_resources", {}));
        return;
      }
      break;
    case "skill":
      runSkillCommand(rest);
      return;
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(usage() + "\n");
      return;
  }
  process.stderr.write(usage() + "\n");
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`foundry: ${message}\n`);
  process.exitCode = 1;
});
