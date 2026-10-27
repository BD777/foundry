import { toast } from "../../components/ui/toast";
import { useRef, useState } from "react";
import { errorText } from "../../lib/errors";

export interface ResourceAction<K extends string> {
  /** The action running now, if any. */
  running?: K;
  /** Last result, retained for diagnostic views; normal feedback floats. */
  notice: string;
  error: string;
  run: (kind: K, action: () => Promise<string>) => Promise<void>;
}

/**
 * One action at a time on a resource: while one runs the others wait;
 * its outcome (a notice or an error) replaces the last one.
 */
export function useResourceAction<K extends string>(
  feedback = true,
): ResourceAction<K> {
  const [running, setRunning] = useState<K>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(false);

  const run = async (kind: K, action: () => Promise<string>) => {
    if (pending.current) return;
    pending.current = true;
    setRunning(kind);
    setNotice("");
    setError("");
    try {
      const message = await action();
      setNotice(message);
      if (feedback && message) toast({ tone: "success", title: message });
    } catch (cause) {
      const message = errorText(cause);
      setError(message);
      if (feedback) toast({ tone: "error", title: message });
    } finally {
      pending.current = false;
      setRunning(undefined);
    }
  };

  return { running, notice, error, run };
}
