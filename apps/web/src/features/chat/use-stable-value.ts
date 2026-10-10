import { useRef } from "react";

function withoutFunctions(_key: string, value: unknown): unknown {
  return typeof value === "function" ? undefined : value;
}

/**
 * The previous value while what it shows is unchanged (compared as JSON,
 * callbacks aside), so memoized consumers skip renders that would change
 * nothing — e.g. the chat list while only a transcript streams. `extraKey`
 * adds what callbacks capture but the value does not show.
 */
export function useStableValue<T>(value: T, extraKey = ""): T {
  const key = `${JSON.stringify(value, withoutFunctions) ?? ""}\n${extraKey}`;
  const stable = useRef<{ key: string; value: T }>(undefined);
  if (!stable.current || stable.current.key !== key) {
    stable.current = { key, value };
  }
  return stable.current.value;
}
