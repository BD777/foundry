import { act } from "react";

/** Close the top dialog until no dialog remains. */
export async function closeRadixDialogs(window) {
  for (let attempts = 0; attempts < 4; attempts++) {
    if (!window.document.querySelector('[role="dialog"]')) return;
    await act(async () =>
      window.document.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  }
  throw new Error("Radix dialog did not close during test cleanup");
}

/**
 * Radix focus guards use zero-delay timers. A final timer queued after its
 * cleanup runs only after those earlier callbacks, without an arbitrary sleep.
 */
export async function flushRadixTimers(window) {
  await act(
    async () => new Promise((resolve) => window.setTimeout(resolve, 0)),
  );
}
