import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const indexPath = resolve("index.html");
const cssPath = resolve("src/styles.css");
const index = readFileSync(indexPath, "utf8");
const css = readFileSync(cssPath, "utf8");
const failures = [];

if (/fonts\.(?:googleapis|gstatic)\.com/.test(index)) {
  failures.push(
    "index.html must use the system font stack without remote font dependencies",
  );
}

if (/^@import\s+url\(["']?https:\/\/fonts\.googleapis\.com/m.test(css)) {
  failures.push("src/styles.css must not load Google Fonts through @import");
}

if (failures.length > 0) {
  console.error("Web entry audit failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Web entry audit passed.");
