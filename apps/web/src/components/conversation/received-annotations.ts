import type { SessionInputAnnotation } from "@bd777/foundry-protocol";
import {
  type ConversationAnnotation,
  anchorTextHash,
  stripAnnotationWrapper,
} from "./annotations";

/** The annotations a sent message carries, with the anchor the server kept. */
export function receivedAnnotations(
  annotations: readonly SessionInputAnnotation[] | undefined,
): ConversationAnnotation[] | undefined {
  if (!annotations?.length) return undefined;
  return annotations.map((annotation) => {
    const { startOffset, endOffset, ...rest } = annotation;
    return {
      ...rest,
      ...(startOffset !== undefined && endOffset !== undefined
        ? {
            anchor: {
              start: startOffset,
              end: endOffset,
              textHash: anchorTextHash(annotation.selectedText),
            },
          }
        : {}),
    };
  });
}

/** The text as the person wrote it: an annotated message drops its wrapper. */
export function sentPromptText(
  prompt: string,
  annotations: readonly unknown[] | undefined,
): string {
  return annotations?.length ? stripAnnotationWrapper(prompt) : prompt;
}
