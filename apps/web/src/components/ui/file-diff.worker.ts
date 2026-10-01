import { createFileDiff, type FileDiffError } from "./file-diff-engine";
self.onmessage = (event: MessageEvent<{ before: string; after: string }>) => {
  try {
    self.postMessage(createFileDiff(event.data.before, event.data.after));
  } catch {
    const error: FileDiffError = "failed";
    self.postMessage({ error });
  }
};
