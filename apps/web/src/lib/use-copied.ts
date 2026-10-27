import { toast } from "../components/ui/toast";
import { i18n } from "../i18n";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copies text to the clipboard and remembers which copy (by `key`) last
 * succeeded, for a "Copied" label. A failed copy clears it; with `resetMs`
 * it clears itself after that long, otherwise it stays until `reset`.
 * Pass feedback=false only when the caller supplies its own Toast notice.
 */
export function useCopied(resetMs?: number, feedback = true) {
  const [copiedKey, setCopiedKey] = useState<string>();
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string, key = ""): Promise<boolean> => {
      let copied = true;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        copied = false;
      }
      window.clearTimeout(timer.current);
      setCopiedKey(copied ? key : undefined);
      if (feedback)
        toast({
          tone: copied ? "success" : "error",
          title: i18n.t(
            copied ? "common:actions.copied" : "common:actions.copyFailed",
          ),
        });
      if (copied && resetMs !== undefined)
        timer.current = window.setTimeout(
          () => setCopiedKey(undefined),
          resetMs,
        );
      return copied;
    },
    [resetMs, feedback],
  );

  const reset = useCallback(() => {
    window.clearTimeout(timer.current);
    setCopiedKey(undefined);
  }, []);

  return {
    copied: (key = "") => copiedKey === key,
    copy,
    reset,
  };
}
