import type { ReactNode } from "react";

/** The line the Workspaces page shows where it has nothing to list. */
export function LocationEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-3 text-xs leading-[1.7] text-ink-muted">{children}</p>
  );
}
