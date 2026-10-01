import type {
  ClaudeEffort,
  CodexReasoningEffort,
} from "@bd777/foundry-protocol";
import { i18n } from "../i18n";

export interface EffortOption<T> {
  label: string;
  value: T;
}

const codexEfforts: CodexReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
const claudeEfforts: ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];

export function effortLabel(
  value: ClaudeEffort | CodexReasoningEffort,
): string {
  return i18n.t(`agents:effort.${value}`);
}

export function codexEffortOptions(): EffortOption<CodexReasoningEffort>[] {
  return codexEfforts.map((value) => ({ label: effortLabel(value), value }));
}

export function claudeEffortOptions(): EffortOption<ClaudeEffort>[] {
  return claudeEfforts.map((value) => ({ label: effortLabel(value), value }));
}
