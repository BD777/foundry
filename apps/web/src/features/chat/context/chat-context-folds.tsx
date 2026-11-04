import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/cn";

/** Open folds by chat and section, for this page's lifetime only. */
const openFolds = new Map<string, boolean>();

/**
 * Whether a section's finished rows are unfolded: remembered per chat while
 * the page lives, closed for a chat not seen yet.
 */
export function useFoldOpen(
  memoryKey: string | undefined,
): [boolean, (open: boolean) => void] {
  const [local, setLocal] = useState(false);
  const [, setVersion] = useState(0);
  if (!memoryKey) return [local, setLocal];
  return [
    openFolds.get(memoryKey) ?? false,
    (open) => {
      openFolds.set(memoryKey, open);
      setVersion((version) => version + 1);
    },
  ];
}

/** Finished rows behind one "12 finished" row that opens and closes them. */
export function FinishedFold({
  children,
  label,
  memoryKey,
  appearance = "default",
}: {
  children: ReactNode;
  label: string;
  memoryKey?: string;
  appearance?: "default" | "plain";
}) {
  const [open, setOpen] = useFoldOpen(memoryKey);
  const id = useId();
  return (
    <>
      <Button
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        className={cn(
          "justify-start",
          appearance === "plain"
            ? "min-h-7 gap-1.5 rounded-none px-0 py-1 text-xs active:scale-100 font-medium text-ink-muted hover:text-ink"
            : "fdy-chat-context-fold w-full gap-2.5 rounded-lg px-1.5 py-0 font-semibold text-ink-muted active:scale-100",
        )}
        onClick={() => setOpen(!open)}
        size="sm"
        variant={appearance === "plain" ? "bare" : "ghost"}
      >
        {appearance === "plain" ? label : null}
        <span
          className={cn(
            "inline-flex",
            appearance === "default" && "w-7 flex-none justify-center",
          )}
        >
          {open ? (
            <ChevronDown aria-hidden="true" size={14} />
          ) : (
            <ChevronRight aria-hidden="true" size={14} />
          )}
        </span>
        {appearance === "default" ? label : null}
      </Button>
      {open ? (
        <div
          className={appearance === "plain" ? "min-w-0" : "grid gap-2.5"}
          id={id}
        >
          {children}
        </div>
      ) : null}
    </>
  );
}

/** "12 finished", or "12 finished · 1 failed" so a failure is not lost. */
export function finishedFoldLabel(finished: string, failed?: string): string {
  return failed ? `${finished} · ${failed}` : finished;
}

/**
 * Focuses a section's row when a new reveal request names it first, e.g. the
 * composer's "1 subagent running in the background" note.
 */
export function useRevealedRow(
  reveal: { ids: string[] } | undefined,
): (id: string) => (element: HTMLButtonElement | null) => void {
  const rows = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    const first = reveal?.ids[0];
    const row = first ? rows.current.get(first) : undefined;
    if (!row) return;
    row.focus();
    row.scrollIntoView?.({ block: "nearest" });
    // Only a new reveal request moves the focus.
  }, [reveal]);
  return (id) => (element) => {
    if (element) rows.current.set(id, element);
    else rows.current.delete(id);
  };
}
