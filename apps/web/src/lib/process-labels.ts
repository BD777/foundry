import {
  completedProcessLabelKeys,
  processDetailKey,
  processLabelKey,
  type ProcessLabelKey,
} from "@bd777/foundry-protocol";
import { i18n } from "../i18n";

export { isProcessLabel, processLabelKey } from "@bd777/foundry-protocol";
export type { ProcessLabelKey } from "@bd777/foundry-protocol";

/**
 * A worker-recorded label in the viewer's language. Current English values
 * and the Chinese ones older workers wrote both translate; anything else is
 * agent-written text and stays as it is.
 */
export function displayProcessLabel(text: string): string;
export function displayProcessLabel(
  text: string | undefined,
): string | undefined;
export function displayProcessLabel(
  text: string | undefined,
): string | undefined {
  const key = processLabelKey(text);
  return key ? processLabelText(key) : text;
}

export function processLabelText(key: ProcessLabelKey): string {
  return i18n.t(`conversation:processLabels.${key}`);
}

/** The key a label takes once its step has finished. */
export function completedProcessLabelKey(
  key: ProcessLabelKey,
): ProcessLabelKey {
  return completedProcessLabelKeys[key] ?? key;
}

/** Whether the label names a step still in progress. */
export function isInProgressProcessLabel(key: ProcessLabelKey): boolean {
  return key in completedProcessLabelKeys;
}

/**
 * A worker-recorded detail in the viewer's language when it is exactly one
 * of the worker's fixed sentences (current English or legacy Chinese);
 * anything else is content and stays as it is.
 */
export function displayProcessDetail(text: string): string {
  const key = processDetailKey(text);
  return key ? i18n.t(`conversation:processDetails.${key}`) : text;
}
