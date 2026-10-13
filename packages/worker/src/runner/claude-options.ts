import type {
  AgentProfileProjection,
  AgentSession,
} from "@bd777/foundry-protocol";
import type { AgentProfileLocalConfig } from "../profiles.js";
import {
  isClarificationSession,
  isUtilitySession,
  isVerificationSession,
} from "../session-roles.js";

export function claudeEffort(
  session: AgentSession,
  profile: AgentProfileLocalConfig,
): AgentProfileProjection["claudeEffort"] {
  return session.claudeEffort ?? profile.claudeEffort;
}

/**
 * A workspace session is the person's own agent on their own device, run
 * headless: nobody is there to answer a permission prompt, so an unanswered
 * prompt only blocks the device's own software. Unless the profile or session
 * chooses otherwise, it runs as the person's terminal agent would with
 * permissions granted. Utility sessions (titles, naming) stay read-only, and
 * an Issue's clarification runs only the tools its role allows.
 */
export const defaultClaudePermissionMode = "bypassPermissions";

export function claudePermissionMode(
  session: AgentSession,
  profile: AgentProfileLocalConfig,
): NonNullable<AgentProfileProjection["claudePermissionMode"]> {
  if (isUtilitySession(session)) {
    return "plan";
  }
  if (isClarificationSession(session) || isVerificationSession(session))
    return "dontAsk";
  return (
    session.claudePermissionMode ??
    profile.claudePermissionMode ??
    defaultClaudePermissionMode
  );
}

/**
 * Claude Code refuses bypassPermissions for root unless the environment says
 * it is a deliberate sandbox. Say so before the SDK fails with a bare
 * refusal.
 */
export function claudeRootBypassRefusal(
  permissionMode: string,
  uid = process.getuid?.(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (permissionMode !== "bypassPermissions" || uid !== 0) return undefined;
  if (env.IS_SANDBOX === "1" || env.CLAUDE_CODE_BUBBLEWRAP) return undefined;
  return "Claude Code does not allow Bypass permissions while the worker runs as root. Run the worker as a regular user, or choose another permission mode for this chat or in the device's Claude Code defaults.";
}

export function claudeMaxTurns(session: AgentSession): number | undefined {
  if (isUtilitySession(session)) {
    return 3;
  }
  const configured = process.env.FOUNDRY_CLAUDE_MAX_TURNS?.trim();
  if (
    !configured ||
    configured === "0" ||
    configured.toLowerCase() === "unlimited"
  ) {
    return undefined;
  }
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.round(parsed))
    : undefined;
}
