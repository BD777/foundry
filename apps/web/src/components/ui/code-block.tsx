import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

/*
 * A code listing after Beautiful UI's CodeBlock (MIT, (c) 2026 Shane Levine):
 * a quiet card on a hairline ring, a slim header carrying the language and the
 * block's actions, and a line-numbered mono body whose wrapped lines stay in
 * the code column. Without a language there is no header: the actions stay
 * visible, out of flow, in the top-right corner like a RecordsTable's toolbar;
 * the first line reserves their width, so at rest they cover nothing, and
 * lines scrolled under them pass beneath a fade from the card's surface.
 */

export interface CodeBlockProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  code: string;
  /** Shown lowercase in the header; empty for a listing without one. */
  language?: string;
  /** The header's actions: icon buttons, e.g. copy and download. */
  actions?: ReactNode;
  lineNumbers?: boolean;
}

/** An icon button in a code block's header. */
export const codeBlockActionClass =
  "grid size-[26px] shrink-0 cursor-pointer place-items-center rounded-sm p-0 text-ink-2 transition-colors duration-150 ease-out-strong hover:bg-hover-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50";

/** The number is a column of its own, so a wrapped line keeps its indent. */
const numbered =
  "grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-4 before:text-right before:font-mono before:[font-size:13px] before:text-ink-3 before:select-none before:content-[counter(line)] before:[counter-increment:line]";

export function CodeBlock({
  actions,
  className,
  code,
  language = "",
  lineNumbers = true,
  ...props
}: CodeBlockProps) {
  const lines = code.replace(/\n+$/, "").split("\n");
  return (
    <div
      className={cn(
        "fdy-code-block relative block w-full overflow-hidden rounded-lg bg-surface shadow-card",
        className,
      )}
      data-language={language || undefined}
      dir="ltr"
      {...props}
    >
      {language ? (
        <div className="flex h-9 items-center justify-between border-b border-line pr-2 pl-3.5 font-mono text-xs leading-none text-ink lowercase">
          <span>{language}</span>
          {actions ? <div className="flex items-center">{actions}</div> : null}
        </div>
      ) : actions ? (
        <div className="absolute top-0 right-0 z-1 flex h-11 items-center rounded-tr-lg bg-[linear-gradient(to_right,transparent,var(--surface)_20px)] pr-1.5 pl-5">
          {actions}
        </div>
      ) : null}
      <div className="max-h-[400px] overflow-x-auto overflow-y-auto py-3 pr-3.5 pl-0 text-xs leading-[1.65] text-ink-2">
        <pre className="m-0 bg-transparent p-0 leading-[1.65] wrap-anywhere whitespace-pre-wrap">
          <code
            className={cn(
              "block bg-transparent p-0 font-mono",
              lineNumbers && "[counter-reset:line] [counter-increment:line_0]",
            )}
          >
            {lines.map((line, index) => (
              <span
                className={cn(
                  "block",
                  lineNumbers && numbered,
                  !language && actions && "first:pr-16",
                )}
                key={index}
              >
                {line || "\n"}
              </span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}
