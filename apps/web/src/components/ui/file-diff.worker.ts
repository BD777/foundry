import { createFileDiff } from "./file-diff-engine";
self.onmessage = (event: MessageEvent<{ before: string; after: string }>) => {
  try {
    self.postMessage(createFileDiff(event.data.before, event.data.after));
  } catch {
    self.postMessage({ error: "Could not calculate this file diff." });
  }
};
