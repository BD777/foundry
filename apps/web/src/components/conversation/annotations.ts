/**
 * Annotations on an agent's answer: a passage the person selected, an
 * optional comment, and the answer it is from. The prompt carries them in the
 * wrapper a Codex App sends, so the model reads the same structure in both
 * runtimes.
 */

import {
  serializeAnnotatedPrompt,
  type AnnotationPromptItem,
} from "@bd777/foundry-protocol";

export type { AnnotationPromptItem };
export {
  annotationInstruction,
  serializeAnnotatedPrompt,
  stripAnnotationWrapper,
} from "@bd777/foundry-protocol";

export interface ConversationAnnotation {
  id: string;
  /** The answer's transcript event: the exact message the passage is from. */
  sourceEventId: string;
  /** The turn as the transcript navigator numbers it (1-based). */
  turnNumber?: number;
  /** When the answer was written (ISO). */
  messageAt?: string;
  selectedText: string;
  comment?: string;
  /** Offsets into the answer's plain text, to mark the passage again. */
  anchor?: AnnotationAnchor;
}

export interface AnnotationAnchor {
  start: number;
  end: number;
  textHash: string;
}

export const annotationLimits = {
  maxComment: 2000,
  maxItems: 20,
  maxSelected: 2000,
} as const;

/** The prompt for a message and its annotations, as the runtime receives it. */
export function annotatedPromptText(
  message: string,
  annotations: readonly ConversationAnnotation[],
): string {
  return serializeAnnotatedPrompt(message, annotations.map(promptItem));
}

export function clampAnnotationText(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

/** FNV-1a over the passage: detects that the answer changed under an anchor. */
export function anchorTextHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** Whether the anchor's passage is still the same text in the answer. */
export function anchorStillMatches(
  plainText: string,
  anchor: AnnotationAnchor,
): boolean {
  if (anchor.end > plainText.length || anchor.start < 0) return false;
  return (
    anchorTextHash(plainText.slice(anchor.start, anchor.end)) ===
    anchor.textHash
  );
}

/** What the server keeps for a sent annotation: the passage's offsets, no hash. */
export interface SentAnnotation {
  id: string;
  sourceEventId: string;
  selectedText: string;
  comment?: string;
  startOffset?: number;
  endOffset?: number;
  turnNumber?: number;
  messageAt?: string;
}

export function sentAnnotation(
  annotation: ConversationAnnotation,
): SentAnnotation {
  return {
    id: annotation.id,
    sourceEventId: annotation.sourceEventId,
    selectedText: annotation.selectedText,
    ...(annotation.comment ? { comment: annotation.comment } : {}),
    ...(annotation.anchor
      ? {
          startOffset: annotation.anchor.start,
          endOffset: annotation.anchor.end,
        }
      : {}),
    ...(annotation.turnNumber === undefined
      ? {}
      : { turnNumber: annotation.turnNumber }),
    ...(annotation.messageAt === undefined
      ? {}
      : { messageAt: annotation.messageAt }),
  };
}

/** The prompt item for a draft annotation, from its stored answer and offsets. */
export function promptItem(
  annotation: ConversationAnnotation,
): AnnotationPromptItem {
  return {
    id: annotation.id,
    selectedText: annotation.selectedText,
    ...(annotation.comment ? { comment: annotation.comment } : {}),
    source: {
      messageId: annotation.sourceEventId,
      ...(annotation.anchor
        ? {
            startOffset: annotation.anchor.start,
            endOffset: annotation.anchor.end,
          }
        : {}),
    },
  };
}

/** A sent annotation's anchor, restored from the offsets the server kept. */
export function anchorFromSent(sent: {
  selectedText: string;
  startOffset?: number;
  endOffset?: number;
}): AnnotationAnchor | undefined {
  if (sent.startOffset === undefined || sent.endOffset === undefined)
    return undefined;
  return {
    start: sent.startOffset,
    end: sent.endOffset,
    textHash: anchorTextHash(sent.selectedText),
  };
}
