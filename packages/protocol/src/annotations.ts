// The annotation wrapper a Codex App sends, and the one Foundry sends. One
// implementation for every deliverer: the Web composes what the person sends,
// and the Worker composes a steer or an input the server delivered.
import type { SessionInputAnnotation } from "./contract.gen.js";

/** The instruction a Codex App puts in front of the annotations, verbatim. */
export const annotationInstruction =
  'Each item contains text selected from an earlier Codex response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment. For every annotation you address, include `:codex-annotation{index="N" id="ID"}`, where N is its one-based array position and ID is its exact id (omit the id attribute if absent). Do not use unstructured annotation labels.';

export const annotationWrapperHeading = "# Response annotations:";
const requestHeading = "## My request:";
// The server trims a prompt's edges, so the leading and trailing newlines may be gone.
const wrapperPattern =
  /^\s*# Response annotations:\n[\s\S]*?\n<\/response-annotations>\n+(?:## My request:\n?)?/;

/** One annotation as the model reads it: where it is from and what it says. */
export interface AnnotationPromptItem {
  id: string;
  selectedText: string;
  comment?: string;
  source: {
    messageId: string;
    startOffset?: number;
    endOffset?: number;
  };
}

/** The prompt the runtime receives: the wrapper, then the person's message. */
export function serializeAnnotatedPrompt(
  message: string,
  items: readonly AnnotationPromptItem[],
): string {
  const json = JSON.stringify(
    items.map((item) => ({
      id: item.id,
      text: item.selectedText,
      ...(item.comment ? { annotation: item.comment } : {}),
      source: item.source,
    })),
  );
  return [
    "",
    annotationWrapperHeading,
    annotationInstruction,
    "<response-annotations>",
    json,
    "</response-annotations>",
    "",
    `${requestHeading}`,
    message,
  ].join("\n");
}

/** A sent annotation as the model reads it, from the server's record. */
export function sessionAnnotationPromptItem(
  annotation: SessionInputAnnotation,
): AnnotationPromptItem {
  return {
    id: annotation.id,
    selectedText: annotation.selectedText,
    ...(annotation.comment ? { comment: annotation.comment } : {}),
    source: {
      messageId: annotation.sourceEventId,
      ...(annotation.startOffset !== undefined &&
      annotation.endOffset !== undefined
        ? {
            startOffset: annotation.startOffset,
            endOffset: annotation.endOffset,
          }
        : {}),
    },
  };
}

/** The person's own message, without the annotation wrapper if it has one. */
export function stripAnnotationWrapper(prompt: string): string {
  const match = prompt.match(wrapperPattern);
  return match ? prompt.slice(match[0].length) : prompt;
}

/** The prompt a delivery carries: the wrapper, unless it already has one. */
export function annotatedMessageText(
  message: string,
  annotations: readonly SessionInputAnnotation[] | undefined,
): string {
  const text = message.trim();
  if (!annotations?.length || text.includes(annotationWrapperHeading))
    return text;
  return serializeAnnotatedPrompt(
    text,
    annotations.map(sessionAnnotationPromptItem),
  );
}
