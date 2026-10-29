import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const styleEntryPath = resolve("src/styles.css");

/**
 * The style sheets in the browser's cascade order: the local `@import`s of
 * src/styles.css as listed there, then any sheet in src/styles or
 * src/components/ui the entry does not import (by name). Reading the sheets
 * by file name instead let a later-imported rule (20-chat-detail.css after
 * 20-chat-list.css) look overridden here while it won in the browser.
 */
export function readStyleSheets() {
  const entryDirectory = dirname(styleEntryPath);
  const imported = [
    ...readFileSync(styleEntryPath, "utf8").matchAll(
      /@import\s+["'](\.\/[^"']+\.css)["']/g,
    ),
  ].map((match) => resolve(entryDirectory, match[1]));
  const seen = new Set(imported);
  // Shared primitives own their visual contracts outside the legacy style bundle.
  const unimported = ["src/styles", "src/components/ui"].flatMap((directory) =>
    readdirSync(resolve(directory))
      .filter((name) => name.endsWith(".css"))
      .sort()
      .map((name) => resolve(directory, name))
      .filter((path) => !seen.has(path)),
  );
  return [...imported, ...unimported].map((path) => ({
    path,
    css: readFileSync(path, "utf8"),
  }));
}

export function readStyleSource() {
  return readStyleSheets()
    .map((sheet) => sheet.css)
    .join("\n");
}
