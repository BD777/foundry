import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { enforceAuditBaseline } from "./audit-baseline.mjs";

const sourceRoot = resolve("src");
const allowedRawControlFiles = new Set(["components/ui/field.tsx"]);
const nativeTags = ["input", "textarea", "select"];

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

const failures = [];

for (const sourcePath of listSourceFiles(sourceRoot)) {
  const relativePath = relative(sourceRoot, sourcePath);
  const source = readFileSync(sourcePath, "utf8");

  for (const tag of nativeTags) {
    let cursor = 0;
    while (true) {
      const start = source.indexOf(`<${tag}`, cursor);
      if (start === -1) {
        break;
      }

      if (!allowedRawControlFiles.has(relativePath)) {
        failures.push({
          line: lineFor(source, start),
          path: relativePath,
          reason: `raw <${tag}> bypasses the Foundry field component layer`,
        });
      }

      cursor = start + tag.length + 1;
    }
  }
}

enforceAuditBaseline({
  auditName: "native-controls",
  failureLabel: "Native control",
  failures,
  signature: (failure) => `${failure.path}|${failure.reason}`,
});
