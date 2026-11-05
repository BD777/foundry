import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type Ref,
} from "react";
import { cn } from "../../lib/cn";
import { Button, type ButtonProps } from "./button";
import { Textarea, type TextareaProps } from "./field";
import { Panel, type PanelProps } from "./panel";
import { SlashMenu, type SlashSuggestion } from "./slash-menu";

/**
 * Low-level writing surface (after Beautiful UI's PromptBar/ChatComposer).
 * Complete chats use the shared Conversation component. Progressive footer
 * compression keys off the composer's own width (the `fdy-composer`
 * container), so a narrow composer inside a wide split pane compresses like
 * a phone.
 */
export function MessageComposer({ className, ...props }: PanelProps) {
  return (
    <Panel
      className={cn(
        "fdy-message-composer @container/fdy-composer relative border-0 bg-panel px-3 py-2.5 shadow-card transition-shadow duration-150 ease-out-strong focus-within:shadow-panel-focus",
        className,
      )}
      {...props}
    />
  );
}

/** The modifier held with Enter: plain, Ctrl/⌘ (mod) or Alt/⌥ (alt). */
export type ComposerSubmitModifier = "none" | "mod" | "alt";

export interface ComposerInputProps extends Omit<TextareaProps, "onSubmit"> {
  /** Enter sends; the host may read the modifier held with it. */
  onSubmit: (modifier: ComposerSubmitModifier) => void;
  submitDisabled?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
  /**
   * Suggestions offered when the user types a "/token" at the caret. Only
   * these items are listed — the host decides what is available (for chats,
   * the workspace's selected skill catalog).
   */
  slashItems?: SlashSuggestion[];
}

/**
 * Matches a "/query" token immediately before the caret that starts a word:
 * at the start of the text or after whitespace, never inside "a/b".
 */
export function activeSlashToken(
  value: string,
  caret: number,
): { slashStart: number; query: string } | undefined {
  const match = /(?:^|\s)\/([\w-]*)$/.exec(value.slice(0, caret));
  if (!match) return undefined;
  const query = match[1] ?? "";
  return { slashStart: caret - query.length - 1, query };
}

/**
 * Enter submits (with Ctrl/⌘ or Alt/⌥ as the host reads them), Shift+Enter
 * inserts a line, and IME confirmation never sends.
 */
export function ComposerInput({
  onKeyDown,
  onSubmit,
  ref,
  submitDisabled = false,
  value,
  slashItems = [],
  onChange,
  onClick,
  onKeyUp,
  ...props
}: ComposerInputProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Bumped whenever the caret or value may have moved, so slash detection
  // re-derives from the DOM selection without owning the caret position.
  const [caretTick, setCaretTick] = useState(0);
  const [escDismissed, setEscDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const setRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") return ref(node);
      if (ref) ref.current = node;
    },
    [ref],
  );

  const slashState = useMemo(() => {
    void caretTick;
    if (typeof value !== "string" || escDismissed) return undefined;
    const textarea = inputRef.current;
    const caret = textarea?.selectionStart ?? value.length;
    const token = activeSlashToken(value, caret);
    if (!token) return undefined;
    const query = token.query.toLowerCase();
    const items = slashItems.filter(
      (item) =>
        item.value.toLowerCase().includes(query) ||
        (item.label ?? item.value).toLowerCase().includes(query),
    );
    return { token, items };
  }, [slashItems, value, caretTick, escDismissed]);

  const slashVisible = slashState !== undefined && slashItems.length > 0;
  const slashCount = slashState?.items.length ?? 0;

  // Reset highlight to the first option whenever the filtered set changes.
  // Not on every caret tick: key-up after ArrowDown/ArrowUp bumps the tick,
  // and resetting then snapped the highlight back to the first item.
  const slashQuery = slashState?.token.query ?? "";
  const slashStart = slashState?.token.slashStart ?? -1;
  useLayoutEffect(
    () => setSlashIndex(0),
    [slashQuery, slashVisible, slashStart],
  );

  const syncCaret = useCallback(() => setCaretTick((tick) => tick + 1), []);

  const commitNativeValue = useCallback((next: string, caret: number) => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, next);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  }, []);

  const acceptSlash = useCallback(
    (index: number) => {
      const textarea = inputRef.current;
      const chosen = slashState?.items[index];
      if (!textarea || !chosen || !slashState || typeof value !== "string")
        return;
      const caret = textarea.selectionStart;
      const next =
        value.slice(0, slashState.token.slashStart) +
        `/${chosen.value} ` +
        value.slice(caret);
      const insertedAt = slashState.token.slashStart + chosen.value.length + 2;
      commitNativeValue(next, insertedAt);
    },
    [commitNativeValue, slashState, value],
  );

  useLayoutEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const resize = () => {
      const computed = window.getComputedStyle(textarea);
      const lineHeight = Number.parseFloat(computed.lineHeight) || 21;
      const padding =
        (Number.parseFloat(computed.paddingTop) || 0) +
        (Number.parseFloat(computed.paddingBottom) || 0);
      const minHeight = lineHeight * 2 + padding;
      const maxHeight = lineHeight * 11 + padding;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
      textarea.style.overflowY =
        textarea.scrollHeight > maxHeight ? "auto" : "hidden";
    };
    resize();
    // Pane resizing changes wrapping even when the draft has not changed.
    let width = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.getBoundingClientRect().width;
      if (nextWidth !== width) {
        width = nextWidth;
        resize();
      }
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [value]);

  return (
    <div className="fdy-composer-input-shell relative min-w-0">
      {slashVisible && slashState ? (
        <SlashMenu
          activeIndex={Math.min(slashIndex, Math.max(slashCount - 1, 0))}
          items={slashState.items}
          onActiveIndex={setSlashIndex}
          onSelect={acceptSlash}
          query={slashState.token.query}
        />
      ) : null}
      <Textarea
        {...props}
        // Only the composer's own input is borderless; other fields placed in
        // the composer (a queued message being edited) keep their own tone.
        className={cn(
          "min-h-[54px] overflow-y-hidden px-0.5 pt-1 pb-3 shadow-none focus:shadow-none aria-busy:cursor-progress aria-busy:text-ink-muted",
          props.className,
        )}
        ref={setRef}
        resize="none"
        rows={2}
        value={value}
        onChange={(event) => {
          onChange?.(event);
          setEscDismissed(false);
          // Re-evaluate after the controlled value commits on the next tick.
          requestAnimationFrame(syncCaret);
        }}
        onClick={(event) => {
          onClick?.(event);
          syncCaret();
        }}
        onKeyUp={(event) => {
          onKeyUp?.(event);
          syncCaret();
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          )
            return;

          if (slashVisible && slashState) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSlashIndex((index) => (index + 1) % slashCount);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setSlashIndex((index) => (index - 1 + slashCount) % slashCount);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setEscDismissed(true);
              return;
            }
            if (
              event.key === "Tab" ||
              (event.key === "Enter" && !event.shiftKey)
            ) {
              if (slashCount > 0) {
                event.preventDefault();
                acceptSlash(Math.min(slashIndex, slashCount - 1));
                return;
              }
            }
          }

          if (event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          if (!submitDisabled)
            onSubmit(
              event.metaKey || event.ctrlKey
                ? "mod"
                : event.altKey
                  ? "alt"
                  : "none",
            );
        }}
      />
    </div>
  );
}

export function ComposerFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  // The action bar always stays on one row; narrow widths collapse labels to
  // icons via container queries instead of wrapping.
  return (
    <div
      className={cn(
        "fdy-composer-footer relative flex min-w-0 flex-nowrap items-center gap-1",
        className,
      )}
      {...props}
    />
  );
}

/** Send, stop the running agent, or a send on its way (busy, inert). */
export type ComposerSubmitState = "send" | "stop" | "sending";

export function ComposerSubmit({
  state = "send",
  className,
  ...props
}: ButtonProps & { state?: ComposerSubmitState }) {
  return (
    <Button
      {...props}
      aria-busy={state === "sending" || undefined}
      className={cn(
        "fdy-composer-submit ml-auto size-[34px] flex-none rounded-full bg-ink text-panel shadow-none hover:bg-ink",
        className,
      )}
      data-state={
        state === "stop" ? "active" : state === "sending" ? "busy" : "idle"
      }
      size="icon"
      variant="primary"
    >
      {state === "stop" ? (
        <Square
          className="fdy-composer-stop-icon fill-current stroke-0"
          size={12}
        />
      ) : state === "sending" ? (
        <LoaderCircle
          className="fdy-composer-busy-icon animate-spinner motion-reduce:animate-none"
          size={16}
        />
      ) : (
        <ArrowUp size={16} />
      )}
    </Button>
  );
}
