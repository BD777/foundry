import type {
  ClaudeEffort,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexSpeed,
} from "@foundry/protocol";

type Options<T> = Array<{ label: string; value: T }>;
export const claudeEffortOptions: Options<ClaudeEffort> = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "XHigh", value: "xhigh" },
  { label: "Max", value: "max" },
];
export const claudePermissionOptions: Options<ClaudePermissionMode> = [
  { label: "Accept edits", value: "acceptEdits" },
  { label: "Auto", value: "auto" },
  { label: "Bypass permissions", value: "bypassPermissions" },
  { label: "Don't ask", value: "dontAsk" },
  { label: "Plan", value: "plan" },
];
export const codexEffortOptions: Options<CodexReasoningEffort> = [
  { label: "Minimal", value: "minimal" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "XHigh", value: "xhigh" },
];
export const codexSandboxOptions: Options<CodexSandboxMode> = [
  { label: "Read only", value: "read-only" },
  { label: "Workspace write", value: "workspace-write" },
  { label: "Danger full access", value: "danger-full-access" },
];
export const codexApprovalOptions: Options<CodexApprovalPolicy> = [
  { label: "Untrusted", value: "untrusted" },
  { label: "On request", value: "on-request" },
  { label: "On failure", value: "on-failure" },
  { label: "Never", value: "never" },
];
export const codexSpeedOptions: Options<CodexSpeed> = [
  { label: "Standard", value: "standard" },
  { label: "Fast", value: "fast" },
];
