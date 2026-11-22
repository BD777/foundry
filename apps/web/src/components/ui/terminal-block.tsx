import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { ScrollArea } from "./scroll-area";

export interface TerminalBlockLine {
  id: string;
  prompt?: ReactNode;
  value: ReactNode;
}

export interface TerminalBlockProps {
  className?: string;
  lines: TerminalBlockLine[];
  /** Class of the scrolling viewport, for its overflow policy. */
  viewportClassName?: string;
}

/*
 * Commands to copy, after Beautiful UI's CodeBlock: mono text on a dark
 * surface, scrolling sideways (wrapping on a narrow screen).
 */
export function TerminalBlock({
  className,
  lines,
  viewportClassName,
}: TerminalBlockProps) {
  return (
    <ScrollArea
      className={cn(
        "fdy-terminal-block max-w-full rounded-md bg-terminal text-terminal-ink [--fdy-scroll-thumb-hover:var(--fdy-ink-faint)] [--fdy-scroll-thumb:var(--fdy-dark-muted)]",
        className,
      )}
      direction="horizontal"
      viewportClassName={viewportClassName}
    >
      <pre className="m-0 min-w-max max-sidebar:min-w-0">
        <code className="block px-[15px] py-[13px] font-mono text-xs leading-[1.7] font-medium max-sidebar:grid max-sidebar:gap-0.5 max-sidebar:px-[13px] max-sidebar:py-3 max-sidebar:leading-[1.65] max-sidebar:whitespace-normal">
          {lines.map((line) => (
            <span
              className="block min-w-0 max-sidebar:grid max-sidebar:grid-cols-[auto_minmax(0,1fr)] max-sidebar:gap-x-1.5"
              key={line.id}
            >
              {line.prompt ? (
                <>
                  <span className="text-terminal-muted">
                    {line.prompt}
                  </span>{" "}
                </>
              ) : null}
              <span className="min-w-0 max-sidebar:[overflow-wrap:anywhere]">
                {line.value}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </ScrollArea>
  );
}
