import { nativeUpdateAdapter } from "./adapters.js";
import type { AgentUpdateAdapter } from "./update-controller.js";

/** New agents register their adapter; scheduling never branches on provider. */
export const agentUpdateAdapters: readonly AgentUpdateAdapter[] = [
  nativeUpdateAdapter("codex"),
  nativeUpdateAdapter("claude"),
];
