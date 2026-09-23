#!/usr/bin/env node

/**
 * `foundry` — the human/agent entry point shipped with @foundry/worker.
 *
 *   foundry mcp                 stdio MCP server for agents
 *   foundry session <verb>      JSON-first session control for people/scripts
 *   foundry profile list        list runnable profiles on this device
 *   foundry skill              print the orchestrator skill
 *
 * Operational worker commands remain on the separate `foundry-worker` bin.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  "thread",
  "chat",
  "subagents",
  "create",
  "handoff",
  "steer",
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
      print(await foundry.getSession(requireId(rest)));
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
    case "steer": {
      const id = rest[0];
      const message = flag(rest, "--message") ?? flag(rest, "--prompt");
      if (!id || !message) {
        throw new FoundryClientError(
          "usage: steer <sessionId> --message <text>",
        );
      }
      print(await foundry.steer(id, message));
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
  if (!id) throw new FoundryClientError("session id is required");
  return id;
}

function printSkill(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "skills", "foundry-orchestrator", "SKILL.md"),
    resolve(here, "..", "..", "skills", "foundry-orchestrator", "SKILL.md"),
  ];
  for (const path of candidates) {
    try {
      process.stdout.write(readFileSync(path, "utf8"));
      return;
    } catch {
      // try next
    }
  }
  throw new FoundryClientError("orchestrator skill file is missing");
}

function usage(): string {
  return [
    "foundry — manage Foundry sessions from a device",
    "",
    "Usage:",
    "  foundry mcp",
    "  foundry session list|children|get|thread|chat|subagents|create|handoff|steer|cancel|wait|rename|groups|group [flags]",
    "  foundry profile list",
    "  foundry skill",
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
    case "skill":
      printSkill();
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
