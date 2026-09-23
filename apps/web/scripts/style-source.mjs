import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const styleEntryPath = resolve("src/styles.css");

export function readStyleSource() {
  const stylesDirectory = resolve("src/styles");
  const styles = readdirSync(stylesDirectory)
    .filter((name) => name.endsWith(".css"))
    .sort()
    .map((name) => readFileSync(resolve(stylesDirectory, name), "utf8"))
    .join("\n");
  // Shared primitives own their visual contracts outside the legacy style bundle.
  const primitivesDirectory = resolve("src/components/ui");
  const primitives = readdirSync(primitivesDirectory)
    .filter((name) => name.endsWith(".css"))
    .sort()
    .map((name) => readFileSync(resolve(primitivesDirectory, name), "utf8"))
    .join("\n");
  return `${styles}\n${primitives}`;
}
