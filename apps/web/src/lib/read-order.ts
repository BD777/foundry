import { useState } from "react";

/**
 * Orders reads of some state against what else shows it: an event that
 * carries the state, an action's answer, a later read. A read's answer
 * applies only if nothing newer was shown after the read started, so a read
 * served before an event but answered after it cannot put the older state
 * back, nor an earlier read overwrite a later one.
 */
export function createReadOrder() {
  let latest = 0;
  return {
    /** Something newer than any read running is shown now. */
    changed(): void {
      latest += 1;
    },
    /** A read starts; returns whether its answer may still be shown. */
    started(): () => boolean {
      const at = ++latest;
      return () => latest === at;
    },
  };
}

export type ReadOrder = ReturnType<typeof createReadOrder>;

/** createReadOrder for a component. */
export function useReadOrder(): ReadOrder {
  const [order] = useState(createReadOrder);
  return order;
}
