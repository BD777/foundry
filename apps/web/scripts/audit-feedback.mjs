import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
const root = resolve("src");
const failures = [];
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? walk(path)
      : /\.tsx?$/.test(path)
        ? [path]
        : [];
  });
}
for (const file of walk(root)) {
  const name = relative(root, file);
  if (name.startsWith("components/ui/")) continue;
  const source = readFileSync(file, "utf8");
  const patterns = [
    [
      /\bfdy-[\w-]+-(?:hint|notice)(?=["'\s])/g,
      "help/state styling must use FieldHint or Alert",
    ],
    [
      /<(?:ContextMenu|DropdownMenu)\.(?:Item|SubTrigger|Separator|Content|SubContent)\b/g,
      "action menus must use the shared row-menu parts",
    ],
    [
      /<Alert\b[^>]*title=\{t\("[^"\n]*\.(?:saved|copied|saveFailed|stopFailed|controlFailed|updateFailed|answerFailed|copyFailed)"/g,
      "transient action feedback must use Toast",
    ],
  ];
  for (const [pattern, reason] of patterns)
    for (const match of source.matchAll(pattern))
      failures.push(
        `${name}:${source.slice(0, match.index).split("\n").length}: ${reason}`,
      );
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    "Feedback and action-menu audit passed (no baseline exemptions).",
  );
