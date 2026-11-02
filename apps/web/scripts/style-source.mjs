import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const sourceRoot = resolve("src");
export const styleEntryPath = resolve("src/styles.css");

/** Every .css file under src except the entry, sorted by path. */
export function styleSheetPaths() {
  return readdirSync(sourceRoot, { recursive: true })
    .filter((name) => name.endsWith(".css"))
    .map((name) => join(sourceRoot, name))
    .filter((path) => path !== styleEntryPath)
    .sort();
}

/** The local sheets src/styles.css imports, resolved, in the order listed. */
export function importedStylePaths() {
  const entryDirectory = dirname(styleEntryPath);
  return [
    ...readFileSync(styleEntryPath, "utf8").matchAll(
      /@import\s+["'](\.\/[^"']+\.css)["']/g,
    ),
  ].map((match) => resolve(entryDirectory, match[1]));
}

/**
 * The style sheets in the browser's cascade order: the local `@import`s of
 * src/styles.css as listed there, then any sheet under src the entry does
 * not import (by path), so an audit still sees a sheet someone forgot to
 * import. Reading the sheets by file name instead let a later-imported rule
 * look overridden here while it won in the browser.
 */
export function readStyleSheets() {
  const imported = importedStylePaths();
  const seen = new Set(imported);
  const unimported = styleSheetPaths().filter((path) => !seen.has(path));
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
