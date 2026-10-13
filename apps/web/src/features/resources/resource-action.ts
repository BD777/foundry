import { useEffect, useRef, useState } from "react";

export interface ResourceAction<K extends string> {
  /** The action running now, if any. */
  running?: K;
  /** What the last action said, for a status line. */
  notice: string;
  error: string;
  run: (kind: K, action: () => Promise<string>) => Promise<void>;
}

/**
 * One action at a time on a resource: while one runs the others wait;
 * its outcome (a notice or an error) replaces the last one.
 */
export function useResourceAction<K extends string>(): ResourceAction<K> {
  const [running, setRunning] = useState<K>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async (kind: K, action: () => Promise<string>) => {
    if (pending.current) return;
    pending.current = true;
    setRunning(kind);
    setNotice("");
    setError("");
    try {
      const said = await action();
      if (mounted.current) setNotice(said);
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setRunning(undefined);
    }
  };

  return { running, notice, error, run };
}
