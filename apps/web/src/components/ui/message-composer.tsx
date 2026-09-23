import { ArrowUp, Square } from "lucide-react";
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

/** Low-level writing surface. Complete chats use the shared Conversation component. */
export function MessageComposer({ className, ...props }: PanelProps) {
  return <Panel className={cn("fdy-message-composer", className)} {...props} />;
}

export interface ComposerInputProps extends Omit<TextareaProps, "onSubmit"> {
  onSubmit: () => void;
  submitDisabled?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
  /**
   * Suggestions offered when the user types a "/token" at the caret. Only
   * these items are listed — the host decides what is available (for chats,
   * the workspace's selected skill catalog).
   */
  slashItems?: SlashSuggestion[];
}

/** Matches a "/query" token immediately before the caret, at line start. */
function activeSlashToken(
  value: string,
  caret: number,
): { slashStart: number; query: string } | undefined {
  const before = value.slice(0, caret);
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);
  const match = /^\s*\/([\w-]*)$/.exec(line);
  if (!match) return undefined;
  return { slashStart: lineStart + line.indexOf("/"), query: match[1] ?? "" };
}

/** Enter submits, Shift+Enter inserts a line, and IME confirmation never sends. */
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
  const slashQuery = slashState?.token.query ?? "";
  useLayoutEffect(
    () => setSlashIndex(0),
    [slashQuery, slashVisible, caretTick],
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
    <div className="fdy-composer-input-shell">
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
          if (!submitDisabled) onSubmit();
        }}
      />
    </div>
  );
}

export function ComposerFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("fdy-composer-footer", className)} {...props} />;
}

export function ComposerSubmit({
  active = false,
  className,
  ...props
}: ButtonProps & { active?: boolean }) {
  return (
    <Button
      {...props}
      className={cn("fdy-composer-submit", className)}
      data-state={active ? "active" : "idle"}
      size="icon"
      variant="primary"
    >
      {active ? (
        <Square className="fdy-composer-stop-icon" size={12} />
      ) : (
        <ArrowUp size={16} />
      )}
    </Button>
  );
}
