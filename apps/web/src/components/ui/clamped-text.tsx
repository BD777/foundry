import { cva, type VariantProps } from "class-variance-authority";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Button } from "./button";

/*
 * Long agent-written prose (a review's summary, a finding, a reason) never
 * lands in the page at full size: it reads in the body scale, clamps to a few
 * lines, and offers 展开 only when it is actually cut. The `fdy-clamped-text*`
 * classes are hooks for tests and carry no style.
 */
const clampClass = {
  1: "line-clamp-1",
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
  5: "line-clamp-5",
  6: "line-clamp-6",
} as const;

export type ClampLines = keyof typeof clampClass;

export const clampedTextVariants = cva(
  "min-w-0 whitespace-pre-wrap wrap-anywhere",
  {
    variants: {
      size: {
        sm: "text-sm leading-[1.6]",
        xs: "text-xs leading-[1.55]",
      },
      tone: {
        muted: "text-ink-muted",
        faint: "text-ink-faint",
        ink: "text-ink",
      },
    },
    defaultVariants: { size: "sm", tone: "muted" },
  },
);

export interface ClampedTextProps extends VariantProps<
  typeof clampedTextVariants
> {
  children: ReactNode;
  /** Lines shown while collapsed. */
  clamp?: ClampLines;
  className?: string;
  /** The toggle's labels; the shared text when the caller has none. */
  moreLabel?: string;
  lessLabel?: string;
}

/**
 * Secondary prose that clamps and says so. The text always holds its full
 * content; only the visual box is cut, so a reader of the page gets the whole
 * text and a screen reader does too. The toggle appears only when the text
 * overflows the clamp, and reports its state with `aria-expanded`.
 */
export function ClampedText({
  children,
  clamp = 3,
  size,
  tone,
  className,
  moreLabel,
  lessLabel,
}: ClampedTextProps) {
  const { t } = useTranslation("ui");
  const text = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const id = useId();
  useLayoutEffect(() => {
    const element = text.current;
    if (!element) return;
    let cancelled = false;
    // The clamped box is the only one whose height says whether anything is
    // hidden; while expanded it is the whole text, so the last answer stands.
    const measure = () => {
      if (cancelled || expanded) return;
      setOverflows(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    // Web fonts arrive after the first layout and change where lines break.
    if (document.fonts?.ready) void document.fonts.ready.then(measure);
    // A browser reports resize; a test DOM without layout measures once.
    if (typeof ResizeObserver === "undefined")
      return () => {
        cancelled = true;
      };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [children, clamp, expanded]);
  return (
    <div className="fdy-clamped-text grid min-w-0 justify-items-start gap-0.5">
      <p
        className={cn(
          clampedTextVariants({ size, tone }),
          !expanded && clampClass[clamp],
          className,
        )}
        data-clamped={!expanded && overflows ? "true" : "false"}
        id={id}
        ref={text}
      >
        {children}
      </p>
      {overflows ? (
        <Button
          aria-controls={id}
          aria-expanded={expanded}
          className="text-xs text-ink-muted hover:text-ink"
          onClick={() => setExpanded((value) => !value)}
          size="inline"
          variant="link"
        >
          {expanded
            ? (lessLabel ?? t("text.showLess"))
            : (moreLabel ?? t("text.showMore"))}
        </Button>
      ) : null}
    </div>
  );
}
