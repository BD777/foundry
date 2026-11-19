import type {
  AgentModelOption,
  ClaudeEffort,
  CodexReasoningEffort,
} from "@bd777/foundry-protocol";
import { i18n } from "../i18n";

export interface EffortOption<T> {
  label: string;
  value: T;
}

const claudeEfforts: ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];
const endpointCodexEfforts: CodexReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/**
 * A value with no label of its own shows as its own name, so a value a newer
 * runtime advertises is still readable instead of a missing-key string.
 */
export function effortLabel(
  value: ClaudeEffort | CodexReasoningEffort,
): string {
  return i18n.t(`agents:effort.${value}`, { defaultValue: value });
}

/**
 * The efforts Codex accepts for one model: exactly those its own catalog lists,
 * in the catalog's order. A model with no catalog entry, or whose catalog names
 * none (an API endpoint), offers the pre-catalog list, and the endpoint decides
 * what it accepts.
 */
export function codexEffortOptions(
  model: AgentModelOption | undefined,
): EffortOption<CodexReasoningEffort>[] {
  const listed = model?.reasoningEfforts ?? [];
  const values = listed.length > 0 ? listed : endpointCodexEfforts;
  return values.map((value) => ({ label: effortLabel(value), value }));
}

/**
 * The catalog entry a model choice means: the named model, or the account's
 * default model when the choice is blank.
 */
export function catalogModel(
  models: readonly AgentModelOption[],
  modelId: string,
): AgentModelOption | undefined {
  return modelId
    ? models.find((model) => model.id === modelId)
    : models.find((model) => model.isDefault);
}

export function claudeEffortOptions(): EffortOption<ClaudeEffort>[] {
  return claudeEfforts.map((value) => ({ label: effortLabel(value), value }));
}
