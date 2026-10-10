/**
 * Pure decisions about which chat hydration requests a selection still needs.
 * Keeping them out of the effects makes the latest-wins lifecycle testable
 * without a React renderer.
 */

export interface ChatDetailHydrationInput {
  /** Chat id whose full detail is already in feature state. */
  hydratedChatId?: string;
  selectedSummary?: { handoffContext?: unknown; id: string };
  /** A live thread already carries the transcript the detail would supply. */
  threadSelected: boolean;
}

/** Chat id that still needs a detail fetch, or `undefined` when none does. */
export function chatDetailHydrationId({
  hydratedChatId,
  selectedSummary,
  threadSelected,
}: ChatDetailHydrationInput): string | undefined {
  if (!selectedSummary) {
    return undefined;
  }
  if (selectedSummary.handoffContext || threadSelected) {
    return undefined;
  }
  return hydratedChatId === selectedSummary.id ? undefined : selectedSummary.id;
}
