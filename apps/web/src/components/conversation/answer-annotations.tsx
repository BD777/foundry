import {
  autoUpdate,
  hide,
  useFloating,
  type Placement,
  type VirtualElement,
} from "@floating-ui/react-dom";
import { Trash2 } from "lucide-react";
import type { CSSProperties } from "react";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Popover } from "../ui/popover";
import { Textarea } from "../ui/field";
import { Tooltip } from "../ui/tooltip";
import {
  annotationLimits,
  anchorTextHash,
  type AnnotationAnchor,
  type ConversationAnnotation,
} from "./annotations";
import { AnnotationReferenceContext } from "./annotation-reference";
import {
  answerSurface,
  tableMirrorSurface,
  type AnnotationSurface,
} from "./annotation-surfaces";

export interface AnswerSelectionDraft {
  selectedText: string;
  anchor: AnnotationAnchor;
  comment?: string;
}

interface PendingSelection {
  draft: Omit<AnswerSelectionDraft, "comment">;
  range: Range;
}

interface AnswerAnnotationsProps {
  /** The answer's transcript event: the ref every annotation on it carries. */
  answerId: string;
  /** Every annotation in the draft, so markers number like the composer list. */
  annotations?: readonly ConversationAnnotation[];
  /** Selecting and marking need a composer; highlights of sent ones do not. */
  enabled: boolean;
  onAdd?: (draft: AnswerSelectionDraft) => void;
  onUpdate?: (id: string, comment: string) => void;
  /** Takes the annotation out of the draft entirely, marker included. */
  onRemove?: (id: string) => void;
  children: ReactNode;
}

interface AnswerAnnotationState {
  answerId: string;
  annotations: readonly ConversationAnnotation[];
  sent: readonly ConversationAnnotation[];
  enabled: boolean;
  onAdd?: (draft: AnswerSelectionDraft) => void;
  onUpdate?: (id: string, comment: string) => void;
  onRemove?: (id: string) => void;
  /** The answer's rendered text: annotation offsets count its textContent. */
  root: HTMLElement | null;
  /** Changes whenever the answer's DOM does, so live ranges are rebuilt. */
  version: number;
}

const AnswerAnnotationContext = createContext<AnswerAnnotationState | null>(
  null,
);

/** Highlights are painted by the browser on the text itself (CSS Custom
 *  Highlight API), so they scroll with any container the text sits in. The
 *  style is `::highlight(answer-annotation)` in styles/foundation.css. */
const highlightName = "answer-annotation";

function annotationHighlight(): Highlight | null {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return null;
  const existing = CSS.highlights.get(highlightName);
  if (existing) return existing;
  const created = new Highlight();
  CSS.highlights.set(highlightName, created);
  return created;
}

/** The selection's anchor, if it lies inside the surface's text. */
function readSelection(
  content: HTMLElement,
  surface: AnnotationSurface,
): PendingSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
    return null;
  const range = selection.getRangeAt(0);
  if (!content.contains(range.commonAncestorContainer)) return null;
  const offsets = surface.offsetsFor(range);
  if (!offsets || offsets.end <= offsets.start) return null;
  const raw = surface.text().slice(offsets.start, offsets.end);
  const selectedText = raw.trim().slice(0, annotationLimits.maxSelected);
  if (!selectedText) return null;
  const start = offsets.start + (raw.length - raw.trimStart().length);
  return {
    draft: {
      selectedText,
      anchor: {
        start,
        end: start + selectedText.length,
        textHash: anchorTextHash(selectedText),
      },
    },
    range: range.cloneRange(),
  };
}

/** Counts changes to the element's DOM (text replaced on re-render). */
function useDomVersion(element: HTMLElement | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!element) return;
    const observer = new MutationObserver(() =>
      setVersion((current) => current + 1),
    );
    observer.observe(element, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [element]);
  return version;
}

/** The end of a range as a zero-size point Floating UI can anchor to. */
function rangeEndAnchor(range: Range): VirtualElement {
  const container = range.endContainer;
  return {
    getBoundingClientRect() {
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
      return new DOMRect(last.right, last.top, 0, 0);
    },
    contextElement:
      container instanceof Element
        ? container
        : (container.parentElement ?? undefined),
  };
}

/**
 * Keeps its children at the end of a text range. Floating UI follows every
 * scroll container between the text and the page (a table that scrolls
 * sideways, the transcript) and hides them when the text is scrolled out.
 */
function RangeAnchored({
  children,
  placement,
  range,
}: {
  children: ReactNode;
  placement: Placement;
  range: Range;
}) {
  const reference = useMemo(() => rangeEndAnchor(range), [range]);
  const { isPositioned, middlewareData, refs, x, y } = useFloating({
    elements: { reference },
    middleware: [hide({ strategy: "referenceHidden" })],
    placement,
    whileElementsMounted: autoUpdate,
  });
  return (
    <span
      className={cn(
        "absolute top-(--fdy-annotation-top) left-(--fdy-annotation-left) z-10",
        (!isPositioned || middlewareData.hide?.referenceHidden) && "invisible",
      )}
      ref={refs.setFloating}
      style={
        {
          "--fdy-annotation-left": `${x}px`,
          "--fdy-annotation-top": `${y}px`,
        } as CSSProperties
      }
    >
      {children}
    </span>
  );
}

/**
 * Annotations on a finished agent answer: a floating affordance on a text
 * selection, highlights on sent annotations and numbered markers at the end of
 * each draft one. Its tables' expanded views show and take the same
 * annotations through `AnnotationMirror`.
 */
export function AnswerAnnotations({
  answerId,
  annotations = NO_ANNOTATIONS,
  children,
  enabled,
  onAdd,
  onUpdate,
  onRemove,
}: AnswerAnnotationsProps) {
  const reference = useContext(AnnotationReferenceContext);
  const sent = reference?.sentFor(answerId) ?? NO_ANNOTATIONS;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const version = useDomVersion(root);
  const state = useMemo<AnswerAnnotationState>(
    () => ({
      answerId,
      annotations,
      sent,
      enabled,
      onAdd,
      onUpdate,
      onRemove,
      root,
      version,
    }),
    [
      answerId,
      annotations,
      sent,
      enabled,
      onAdd,
      onUpdate,
      onRemove,
      root,
      version,
    ],
  );
  const surface = useMemo(() => (root ? answerSurface(root) : null), [root]);
  return (
    <AnswerAnnotationContext.Provider value={state}>
      <div className="relative" data-answer-annotations={answerId}>
        <div ref={setRoot}>{children}</div>
        {root && surface ? (
          <AnnotationLayer
            content={root}
            state={state}
            surface={surface}
            version={version}
          />
        ) : null}
      </div>
    </AnswerAnnotationContext.Provider>
  );
}

/**
 * The expanded copy of a table in an annotated answer: shows the answer's
 * annotations on it and lets the person annotate from it. Outside an annotated
 * answer it renders its children unchanged.
 */
export function AnnotationMirror({
  children,
  source,
}: {
  children: ReactNode;
  /** The table in the answer this copy shows. */
  source: () => HTMLTableElement | null;
}) {
  const state = useContext(AnswerAnnotationContext);
  if (!state) return <>{children}</>;
  return (
    <TableMirror source={source} state={state}>
      {children}
    </TableMirror>
  );
}

function TableMirror({
  children,
  source,
  state,
}: {
  children: ReactNode;
  source: () => HTMLTableElement | null;
  state: AnswerAnnotationState;
}) {
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const ownVersion = useDomVersion(content);
  const { root } = state;
  const surface = useMemo(() => {
    const mirror = content?.querySelector("table");
    const from = source();
    return root && mirror && from
      ? tableMirrorSurface(root, from, mirror)
      : null;
    // The tables' DOM changes with the versions; the surface reads it lazily.
  }, [content, root, source]);
  return (
    <div className="relative">
      <div ref={setContent}>{children}</div>
      {content && surface ? (
        <AnnotationLayer
          content={content}
          state={state}
          surface={surface}
          version={state.version + ownVersion}
        />
      ) : null}
    </div>
  );
}

function AnnotationLayer({
  content,
  state,
  surface,
  version,
}: {
  /** Where selections count: the surface's rendered text. */
  content: HTMLElement;
  state: AnswerAnnotationState;
  surface: AnnotationSurface;
  version: number;
}) {
  const { t } = useTranslation("conversation");
  const { annotations, answerId, enabled, onAdd, onRemove, onUpdate, sent } =
    state;
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<Range[]>([]);
  const [markers, setMarkers] = useState<
    { annotation: ConversationAnnotation; index: number; range: Range }[]
  >([]);
  const editorOpenRef = useRef(false);
  editorOpenRef.current = editorOpen;

  useEffect(() => {
    if (!enabled) return;
    const onSelectionChange = () => {
      // The editor keeps its snapshot: focusing its textarea clears the selection.
      if (editorOpenRef.current) return;
      setPending(readSelection(content, surface));
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, [content, enabled, surface]);

  useLayoutEffect(() => {
    setHighlights(
      sent.flatMap((annotation) => {
        const range = annotation.anchor && surface.rangeFor(annotation.anchor);
        return range ? [range] : [];
      }),
    );
    if (!enabled) {
      setMarkers([]);
      return;
    }
    setMarkers(
      annotations.flatMap((annotation, index) => {
        if (annotation.sourceEventId !== answerId || !annotation.anchor)
          return [];
        const range = surface.rangeFor(annotation.anchor);
        return range ? [{ annotation, index, range }] : [];
      }),
    );
  }, [annotations, answerId, enabled, sent, surface, version]);

  useEffect(() => {
    const registry = annotationHighlight();
    if (!registry || highlights.length === 0) return;
    for (const range of highlights) registry.add(range);
    return () => {
      for (const range of highlights) registry.delete(range);
    };
  }, [highlights]);

  function submit(
    draft: Omit<AnswerSelectionDraft, "comment">,
    comment: string,
  ) {
    const trimmed = comment.trim().slice(0, annotationLimits.maxComment);
    onAdd?.({ ...draft, ...(trimmed ? { comment: trimmed } : {}) });
    setPending(null);
    setEditorOpen(false);
    window.getSelection()?.removeAllRanges();
  }

  return (
    <>
      {enabled && pending ? (
        <RangeAnchored placement="top-start" range={pending.range}>
          <Popover
            label={t("annotations.addComment")}
            onOpenChange={setEditorOpen}
            open={editorOpen}
            surface="card"
            trigger={
              <Button
                onMouseDown={(event) => event.preventDefault()}
                size="sm"
                type="button"
                variant="secondary"
              >
                {t("annotations.comment")}
              </Button>
            }
          >
            <AnnotationEditor
              initialComment=""
              onCancel={() => setEditorOpen(false)}
              onSubmit={(comment) => submit(pending.draft, comment)}
            />
          </Popover>
        </RangeAnchored>
      ) : null}
      {enabled
        ? markers.map(({ annotation, index, range }) => (
            <RangeAnchored key={annotation.id} placement="bottom" range={range}>
              <Tooltip
                content={annotation.comment || t("annotations.noComment")}
                variant="hint"
              >
                <span className="block -translate-y-1/2">
                  <Popover
                    label={t("annotations.markerLabel", { number: index + 1 })}
                    onOpenChange={(open) =>
                      setEditingId(open ? annotation.id : null)
                    }
                    open={editingId === annotation.id}
                    surface="card"
                    trigger={
                      <Button
                        aria-label={t("annotations.markerLabel", {
                          number: index + 1,
                        })}
                        className="rounded-full bg-brand text-2xs font-semibold text-on-brand shadow-btn"
                        size="iconXs"
                        type="button"
                        variant="bare"
                      >
                        {index + 1}
                      </Button>
                    }
                  >
                    <AnnotationEditor
                      initialComment={annotation.comment ?? ""}
                      onCancel={() => setEditingId(null)}
                      onDelete={
                        onRemove
                          ? () => {
                              onRemove(annotation.id);
                              setEditingId(null);
                            }
                          : undefined
                      }
                      onSubmit={(comment) => {
                        onUpdate?.(
                          annotation.id,
                          comment.trim().slice(0, annotationLimits.maxComment),
                        );
                        setEditingId(null);
                      }}
                    />
                  </Popover>
                </span>
              </Tooltip>
            </RangeAnchored>
          ))
        : null}
    </>
  );
}

const NO_ANNOTATIONS: readonly ConversationAnnotation[] = [];

/** The optional comment: ✓ or Cmd/Ctrl+Enter submits, Escape cancels. */
export function AnnotationEditor({
  initialComment,
  onCancel,
  onDelete,
  onSubmit,
}: {
  initialComment: string;
  onCancel: () => void;
  /** An existing annotation can be removed from its own editor. */
  onDelete?: () => void;
  onSubmit: (comment: string) => void;
}) {
  const { t } = useTranslation("conversation");
  const [comment, setComment] = useState(initialComment);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit(comment);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="flex w-72 max-w-full flex-col gap-2">
      <Textarea
        aria-label={t("annotations.commentLabel")}
        autoFocus
        fieldSize="token"
        maxLength={annotationLimits.maxComment}
        tone="boxed"
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t("annotations.commentPlaceholder")}
        value={comment}
      />
      <div className="flex items-center justify-between gap-2">
        {onDelete ? (
          <Button onClick={onDelete} size="sm" type="button" variant="ghost">
            <Trash2 aria-hidden="true" size={14} />
            {t("annotations.remove")}
          </Button>
        ) : (
          <span />
        )}
        <Button
          aria-label={t("annotations.submit")}
          onClick={() => onSubmit(comment)}
          size="sm"
          type="button"
          variant="primary"
        >
          ✓
        </Button>
      </div>
    </div>
  );
}
