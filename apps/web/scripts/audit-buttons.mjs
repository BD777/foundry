import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { enforceAuditBaseline } from "./audit-baseline.mjs";

const sourceRoot = resolve("src");
const allowedRawButtonFiles = new Set(["components/ui/button.tsx"]);

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
    const start = source.indexOf("<button", cursor);
    if (start === -1) {
      break;
    }

    const end = findTagEnd(source, start);
    if (end === -1) {
      failures.push({
        line: lineFor(source, start),
        path: relativePath,
        reason: "opening tag is not closed",
      });
      break;
    }

    if (!allowedRawButtonFiles.has(relativePath)) {
      failures.push({
        line: lineFor(source, start),
        path: relativePath,
        reason: "raw <button> bypasses the Foundry Button component",
      });
    }

    cursor = end + 1;
  }
}

enforceAuditBaseline({
  auditName: "buttons",
  failureLabel: "Button",
  failures,
  signature: (failure) => `${failure.path}|${failure.reason}`,
});
