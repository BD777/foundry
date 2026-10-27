import { createElement, act } from "react";
import { afterEach } from "node:test";
const roots = new Set();
const addedGlobals = new Map();
afterEach(async () => {
  await act(async () => {
    for (const root of [...roots]) root.unmount();
  });
});
/** Features publish feedback into the app shell; mount the same viewport in tests. */
export async function createFeedbackRoot(container) {
  const view = container.ownerDocument.defaultView;
  const values = Object.fromEntries(
    [
      "Event",
      "MouseEvent",
      "PointerEvent",
      "KeyboardEvent",
      "FocusEvent",
      "Node",
      "Element",
      "HTMLElement",
      "HTMLInputElement",
      "HTMLButtonElement",
      "NodeFilter",
      "MutationObserver",
      "ResizeObserver",
      "CustomEvent",
    ].map((name) => [name, view[name]]),
  );
  Object.assign(values, {
    getComputedStyle: view.getComputedStyle.bind(view),
    requestAnimationFrame: view.requestAnimationFrame.bind(view),
    cancelAnimationFrame: view.cancelAnimationFrame.bind(view),
  });
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && globalThis[key] !== value) {
      if (!addedGlobals.has(key))
        addedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value,
      });
    }
  const { createRoot } = await import("react-dom/client");
  const { ToastProvider } = await import("../src/components/ui/toast.tsx");
  const actual = createRoot(container);
  const root = {
    render: (node) => actual.render(createElement(ToastProvider, null, node)),
    unmount: () => {
      if (!roots.has(root)) return;
      container.ownerDocument
        .querySelectorAll(".fdy-toast-close")
        .forEach((button) => button.click());
      actual.unmount();
      roots.delete(root);
      container.remove();
      if (!roots.size) {
        for (const [key, descriptor] of addedGlobals)
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else delete globalThis[key];
        addedGlobals.clear();
      }
    },
  };
  roots.add(root);
  return root;
}
