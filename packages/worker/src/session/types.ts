/**
 * Session roles this runtime starts today. Chat, orchestrated and Issue
 * execution sessions join as they migrate (docs/architecture-modules.md §5.2).
 */
export type SessionRole = "clarification" | "verification";

export interface SessionSpec {
  role: SessionRole;
  harness: "claude" | "codex";
  profileId: string;
  /** Model requested for this session; the profile's model otherwise. */
  model?: string;
  /** Private directory for the session's home and launcher. */
  directory: string;
  /**
   * The directory the session works in, read-only, plus further readable
   * roots such as a worktree's Git directories. Absent: a detached session
   * with no tools.
   */
  workspace?: { path: string; readRoots: string[] };
  controlServerURL?: string;
  systemPrompt: string;
  prompt: {
    text: string;
    images: { mimeType: string; bytes: Buffer }[];
  };
  /** Constrain the final answer to this JSON Schema where the provider can. */
  responseSchema?: Record<string, unknown>;
  /** Fixed session title, so the CLI never spends a model call naming it. */
  title: string;
}

export interface SessionResult {
  /** The closing answer. */
  text: string;
  /** Present when the provider produced schema-constrained output itself. */
  structured?: unknown;
  reportedModel?: string;
  /** The provider's session or thread id. */
  sessionId?: string;
  /** What the session actually did: tool calls and commands, in order. */
  activity: string[];
}

export interface SessionHandle {
  result: Promise<SessionResult>;
  cancel(): void;
}
