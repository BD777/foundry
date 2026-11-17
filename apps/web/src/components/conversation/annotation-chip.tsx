import { MessageSquareText, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Popover } from "../ui/popover";
import type { ConversationAnnotation } from "./annotations";
import { AnnotationEditor } from "./answer-annotations";

/**
 * The composer's count of annotations on answers: a chip that lists them with
 * edit and delete, and clears them all with ×.
 */
export function AnnotationChip({
  annotations,
  onClear,
  onRemove,
  onUpdate,
}: {
  annotations: readonly ConversationAnnotation[];
  onClear: () => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, comment: string) => void;
}) {
  const { t } = useTranslation("conversation");
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  if (annotations.length === 0) return null;
  const count = annotations.length;

  return (
    <div className="flex items-center gap-1">
      <Popover
        label={t("annotations.listTitle")}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setEditingId(null);
        }}
        open={open}
        surface="card"
        trigger={
          <Button
            className="h-8 gap-1.5 rounded-full px-3 text-xs"
            size="sm"
            type="button"
            variant="secondary"
          >
            <MessageSquareText aria-hidden className="size-3.5" />
            {t("annotations.chip", { count })}
          </Button>
        }
      >
        <ol className="flex max-h-80 w-80 max-w-full flex-col gap-3 overflow-y-auto">
          {annotations.map((annotation, index) => (
            <li className="flex flex-col gap-1" key={annotation.id}>
              <div className="flex items-start gap-2">
                <span className="w-4 shrink-0 text-end text-2xs font-semibold">
                  {index + 1}.
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-2xs text-ink-faint">
                    {t("annotations.selected")}
                  </p>
                  <p className="line-clamp-3 text-xs font-normal">
                    {annotation.selectedText}
                  </p>
                </div>
                <Button
                  aria-label={t("annotations.edit")}
                  onClick={() => setEditingId(annotation.id)}
                  size="icon"
                  type="button"
                  variant="icon"
                >
                  <Pencil aria-hidden className="size-3.5" />
                </Button>
                <Button
                  aria-label={t("annotations.remove")}
                  onClick={() => onRemove(annotation.id)}
                  size="icon"
                  type="button"
                  variant="icon"
                >
                  <Trash2 aria-hidden className="size-3.5" />
                </Button>
              </div>
              {editingId === annotation.id ? (
                <div className="ps-6">
                  <AnnotationEditor
                    initialComment={annotation.comment ?? ""}
                    onCancel={() => setEditingId(null)}
                    onSubmit={(comment) => {
                      onUpdate(annotation.id, comment);
                      setEditingId(null);
                    }}
                  />
                </div>
              ) : annotation.comment ? (
                <div className="ps-6">
                  <p className="text-2xs text-ink-faint">
                    {t("annotations.commentOn")}
                  </p>
                  <p className="line-clamp-4 text-xs font-normal">
                    {annotation.comment}
                  </p>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </Popover>
      <Button
        aria-label={t("annotations.clearAll")}
        onClick={onClear}
        size="iconXs"
        type="button"
        variant="icon"
      >
        <X aria-hidden className="size-3.5" />
      </Button>
    </div>
  );
}

/** A sent message's annotations, listed under its text as a disclosure. */
export function SentAnnotations({
  annotations,
}: {
  annotations: readonly ConversationAnnotation[];
}) {
  const { t } = useTranslation("conversation");
  if (annotations.length === 0) return null;
  return (
    <details className="mt-1.5 text-xs">
      <summary className="inline-flex cursor-pointer items-center gap-1.5 rounded-md text-ink-muted hover:text-ink">
        <MessageSquareText aria-hidden className="size-3.5" />
        {t("annotations.sentCount", { count: annotations.length })}
      </summary>
      <ol className="mt-2 flex flex-col gap-2 ps-1">
        {annotations.map((annotation, index) => (
          <li className="flex gap-2" key={annotation.id}>
            <span className="w-4 shrink-0 text-end font-semibold">
              {index + 1}.
            </span>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-ink-muted">
                {annotation.selectedText}
              </p>
              {annotation.comment ? (
                <p className="line-clamp-3 font-normal">{annotation.comment}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}
