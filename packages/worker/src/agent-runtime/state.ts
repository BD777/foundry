import { resolve } from "node:path";
import { foundryStatePath, foundryToolsRoot } from "../state-root.js";
import { readJSONFile, writePrivateJSONAtomic } from "../storage.js";

export type AgentRuntimeId = "codex" | "claude";
export interface RuntimeDescriptor {
  executable: string;
  version: string;
  sdkEntry?: string;
  sdkVersion?: string;
  generation: string;
}
export interface RuntimeUpdateState {
  state:
    | "checking"
    | "current"
    | "available"
    | "waiting_idle"
    | "updating"
    | "failed"
    | "external";
  checkedAt: string;
  target?: string;
  sdkTarget?: string;
  current?: string;
  detail?: string;
  nextCheckAt?: number;
  failureCount?: number;
  /**
   * Worker-local: this state belongs to an install the person started, so it
   * is reported even while the runtime is still missing.
   */
  install?: boolean;
}
const descriptorPath = (id: string) =>
  resolve(foundryToolsRoot(), "agent-runtimes", id, "current.json");
export function runtimeDescriptor(id: string): RuntimeDescriptor | undefined {
  return readJSONFile<RuntimeDescriptor>(descriptorPath(id));
}
export function activateRuntime(
  id: string,
  descriptor: RuntimeDescriptor,
): void {
  const previous = runtimeDescriptor(id);
  if (previous)
    writePrivateJSONAtomic(
      resolve(foundryToolsRoot(), "agent-runtimes", id, "previous.json"),
      previous,
    );
  writePrivateJSONAtomic(descriptorPath(id), descriptor);
}
export function runtimeUpdateState(id: string): RuntimeUpdateState | undefined {
  return readJSONFile<RuntimeUpdateState>(
    foundryStatePath("agent-updates", `${id}.json`),
  );
}
export function saveRuntimeUpdate(id: string, state: RuntimeUpdateState): void {
  writePrivateJSONAtomic(
    foundryStatePath("agent-updates", `${id}.json`),
    state,
  );
}
