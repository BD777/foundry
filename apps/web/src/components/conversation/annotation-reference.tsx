import { createContext, Fragment, useContext } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import type { ConversationAnnotation } from "./annotations";
import { splitAnnotationDirectives } from "./remark-codex-annotations";

/** What an answer's reference to an annotation shows: the passage and the comment. */
export interface AnnotationReferenceValue {
  /** The sent annotation an id names, if the transcript holds it. */
  lookup(id: string): ConversationAnnotation | undefined;
  /** The sent annotations whose passage is in an answer, for highlighting. */
  sentFor(messageId: string): readonly ConversationAnnotation[];
  /** Scrolls to the answer a reference names, and highlights its passage. */
  openSource(messageId: string): void;
}

export const AnnotationReferenceContext = createContext<
  AnnotationReferenceValue | undefined
>(undefined);

/**
 * A numbered reference an answer makes to an annotation the person sent. A
 * known id opens its passage on click and shows it on hover; anything else is
 * the plain number.
 */
export function AnnotationReference({
  id,
  index,
}: {
  id?: string;
  index: number;
}) {
  const { t } = useTranslation("conversation");
  const value = useContext(AnnotationReferenceContext);
  const label = t("annotations.reference", { index });
  const annotation = id ? value?.lookup(id) : undefined;
  if (!annotation || !value) return <span>{label}</span>;
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-1">
          <span>
            {t("annotations.selectedLine", { text: annotation.selectedText })}
          </span>
          {annotation.comment ? (
            <span>
              {t("annotations.commentLine", { text: annotation.comment })}
            </span>
          ) : null}
        </span>
      }
      variant="hint"
    >
      <Button
        onClick={() => value.openSource(annotation.sourceEventId)}
        size="inline"
        type="button"
        variant="link"
      >
        {label}
      </Button>
    </Tooltip>
  );
}

/**
 * Plain text an agent wrote (a snippet, a row that is not Markdown): its
 * annotation directives read as the same references the Markdown shows.
 */
export function AnnotatedText({ text }: { text: string }) {
  return (
    <>
      {splitAnnotationDirectives(text).map((segment, index) =>
        segment.kind === "text" ? (
          <Fragment key={index}>{segment.value}</Fragment>
        ) : (
          <AnnotationReference
            id={segment.id}
            index={segment.index}
            key={index}
          />
        ),
      )}
    </>
  );
}
