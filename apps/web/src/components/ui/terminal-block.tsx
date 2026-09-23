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
}

export function TerminalBlock({ className, lines }: TerminalBlockProps) {
  return (
    <ScrollArea className={cn("fdy-terminal-block", className)}>
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
