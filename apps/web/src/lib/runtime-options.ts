import type {
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexSandboxMode,
  CodexSpeed,
} from "@bd777/foundry-protocol";
import { i18n } from "../i18n";

export { claudeEffortOptions, codexEffortOptions } from "./agent-effort";

type Options<T> = Array<{ label: string; value: T }>;

const claudePermissions: Exclude<ClaudePermissionMode, "default">[] = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
  "plan",
];
const codexSandboxes: CodexSandboxMode[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];
const codexApprovals: CodexApprovalPolicy[] = [
  "untrusted",
  "on-request",
  "on-failure",
  "never",
];
const codexSpeeds: CodexSpeed[] = ["standard", "fast"];

export function claudePermissionOptions(): Options<
  Exclude<ClaudePermissionMode, "default">
> {
  return claudePermissions.map((value) => ({
    label: i18n.t(`agents:claudePermission.${value}`),
    value,
  }));
}

export function codexSandboxOptions(): Options<CodexSandboxMode> {
  return codexSandboxes.map((value) => ({
    label: i18n.t(`agents:codexSandbox.${value}`),
    value,
  }));
}

export function codexApprovalOptions(): Options<CodexApprovalPolicy> {
  return codexApprovals.map((value) => ({
    label: i18n.t(`agents:codexApproval.${value}`),
    value,
  }));
}

export function codexSpeedOptions(): Options<CodexSpeed> {
  return codexSpeeds.map((value) => ({
    label: i18n.t(`agents:codexSpeed.${value}`),
    value,
  }));
}
