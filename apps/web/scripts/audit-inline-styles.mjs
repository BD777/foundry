import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const sourceRoot = resolve("src");
const allowedInlineStyles = new Map([
  [
    "components/ui/confidence-meter.tsx",
    {
      reason:
        "dynamic meter fill is passed through a scoped CSS custom property",
      requiredSnippet: "--fdy-confidence-value",
    },
  ],
]);

function listSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(path);
    }
    return path.endsWith(".tsx") ? [path] : [];
  });
}

function lineFor(source, index) {
  return source.slice(0, index).split("\n").length;
}

function findTagEnd(source, start) {
  let quote = "";
  let braceDepth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const prev = source[index - 1];

    if (quote) {
      if (char === quote && prev !== "\\") {
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{") {
      braceDepth += 1;
      continue;
    }

    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (char === ">" && braceDepth === 0) {
      return index;
    }
  }
  return -1;
}

const failures = [];

for (const sourcePath of listSourceFiles(sourceRoot)) {
  const relativePath = relative(sourceRoot, sourcePath);
  const source = readFileSync(sourcePath, "utf8");
  let cursor = 0;

  while (true) {
    const styleIndex = source.indexOf("style=", cursor);
    if (styleIndex === -1) {
      break;
    }

    const tagStart = source.lastIndexOf("<", styleIndex);
    const tagEnd = tagStart === -1 ? -1 : findTagEnd(source, tagStart);
    const openingTag =
      tagStart !== -1 && tagEnd !== -1
        ? source.slice(tagStart, tagEnd + 1)
        : "";
    const allowed = allowedInlineStyles.get(relativePath);

    if (!allowed || !openingTag.includes(allowed.requiredSnippet)) {
      failures.push({
        line: lineFor(source, styleIndex),
        path: relativePath,
        reason: allowed
          ? `inline style must be limited to ${allowed.requiredSnippet}`
          : "inline style bypasses the Foundry component/token layer",
      });
    }

    cursor = styleIndex + "style=".length;
  }
}

if (failures.length > 0) {
  console.error("Inline style audit failed:");
  for (const failure of failures) {
    console.error(`- src/${failure.path}:${failure.line} ${failure.reason}`);
  }
  process.exit(1);
}

console.log("Inline style audit passed.");
