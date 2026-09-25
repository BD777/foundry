import type { AgentProfileLocalConfig } from "../profiles.js";
import type { SessionPolicy } from "./policy.js";
import type { SessionResult, SessionSpec } from "./types.js";

/** Everything a harness adapter receives; the runtime owns all of it. */
export interface HarnessContext {
  spec: SessionSpec;
  policy: SessionPolicy;
  profile: AgentProfileLocalConfig;
  /** Private, writable home of the session. */
  home: string;
  /** Provider connection environment; the adapter adds its own config dirs. */
  env: Record<string, string>;
  /** Wrap the harness CLI in the session's sandbox; returns its launcher. */
  sandboxedExecutable(command: string): string;
  /** Aborted on timeout or cancel. */
  signal: AbortSignal;
  /** Record a tool call or command the session made. */
  note(entry: string): void;
}

/** One agent harness (Claude, Codex) behind the Session Runtime. */
export interface HarnessAdapter {
  run(context: HarnessContext): Promise<Omit<SessionResult, "activity">>;
}
