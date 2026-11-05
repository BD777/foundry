import { useCallback, useState } from "react";

const storageKey = "foundry.chat.onlyMine";

function storedOnlyMine(): boolean {
  try {
    return window.localStorage.getItem(storageKey) === "true";
  } catch {
    return false;
  }
}

/**
 * "Only my conversation", this browser's choice for every chat: turns the
 * person did not start are hidden rather than folded.
 */
export function useOnlyMine(): [boolean, (next: boolean) => void] {
  const [onlyMine, setOnlyMine] = useState(storedOnlyMine);
  const change = useCallback((next: boolean) => {
    setOnlyMine(next);
    try {
      window.localStorage.setItem(storageKey, String(next));
    } catch {
      // The choice still holds for this page.
    }
  }, []);
  return [onlyMine, change];
}
