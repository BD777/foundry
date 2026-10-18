import { basename } from "node:path";
import { agentUpdateAdapters } from "./registry.js";
import { updateAgentRuntime } from "./update-controller.js";
import {
  agentProcessRegistry,
  readAgentProcessRecords,
  processIdentity,
} from "../agent-processes.js";

/** Recognized runtime ownership lets independent agents update independently. */
export function processRuntime(argv: string[]): "claude" | "codex" | undefined {
  const command = argv[0] ?? "";
  const name = basename(command);
  if (/^claude(?:\.exe|\.js)?$/.test(name) || /[/\\]claude[/\\]/.test(command))
    return "claude";
  if (/^codex(?:\.exe|\.js)?$/.test(name) || /[/\\]codex[/\\]/.test(command))
    return "codex";
  for (const arg of argv.slice(1)) {
    if (arg.includes("@anthropic-ai/claude-agent-sdk/")) return "claude";
    if (arg.includes("@openai/codex/")) return "codex";
  }
  return undefined;
}
export function nativeWorkIsActive(runtime: string): boolean {
  return readAgentProcessRecords(agentProcessRegistry()).some((record) => {
    const owner = processRuntime(record.argv);
    if (owner && owner !== runtime) return false;
    return processIdentity(record.pid)?.startTime === record.startTime;
  });
}

/** Shared scheduler. Provider-specific release/install behavior stays in adapters. */
export function startAgentUpdates(): () => void {
  if (process.env.NODE_TEST_CONTEXT) return () => {};
  let running = false;
  const tick = async () => {
    if (running || process.env.FOUNDRY_AGENT_AUTO_UPDATE === "0") return;
    running = true;
    try {
      for (const adapter of agentUpdateAdapters)
        await updateAgentRuntime(adapter, {
          busy: () => nativeWorkIsActive(adapter.id),
        });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick().catch(console.error), 60_000);
  timer.unref();
  void tick().catch(console.error);
  return () => clearInterval(timer);
}
