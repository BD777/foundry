import type { ClaudeEffort, CodexReasoningEffort } from "@foundry/protocol";

export const codexEffortOptions: Array<{
  label: string;
  summary: string;
  value: CodexReasoningEffort;
}> = [
  { label: "Minimal", summary: "极轻", value: "minimal" },
  { label: "Low", summary: "轻度", value: "low" },
  { label: "Medium", summary: "中", value: "medium" },
  { label: "High", summary: "高", value: "high" },
  { label: "Xhigh", summary: "极高", value: "xhigh" },
];

export const claudeEffortOptions: Array<{
  label: string;
  summary: string;
  value: ClaudeEffort;
}> = [
  { label: "Low", summary: "轻度", value: "low" },
  { label: "Medium", summary: "中", value: "medium" },
  { label: "High", summary: "高", value: "high" },
  { label: "Xhigh", summary: "极高", value: "xhigh" },
  { label: "Max", summary: "最高", value: "max" },
];
