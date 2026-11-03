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

export function TerminalBlock({
  className,
  lines,
  viewportClassName,
}: TerminalBlockProps) {
  return (
    <ScrollArea
      className={cn("fdy-terminal-block", className)}
      direction="horizontal"
      viewportClassName={cn("fdy-terminal-viewport", viewportClassName)}
    >
      <pre>
        <code>
          {lines.map((line) => (
            <span className="fdy-terminal-line" key={line.id}>
              {line.prompt ? (
                <>
                  <span className="fdy-terminal-prompt">
                    {line.prompt}
                  </span>{" "}
                </>
              ) : null}
              <span className="fdy-terminal-command">{line.value}</span>
            </span>
          ))}
        </code>
      </pre>
    </ScrollArea>
  );
}
