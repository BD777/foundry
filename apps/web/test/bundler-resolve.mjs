// `src` uses bundler-style extensionless relative imports. Node's type stripping
// needs explicit specifiers, so tests register this resolver instead of pushing
// test-only import conventions into application code.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const candidateSuffixes = [".ts", ".tsx", "/index.ts", "/index.tsx"];

export async function load(url, context, nextLoad) {
  if (url.endsWith(".css"))
    return {
      format: "module",
      shortCircuit: true,
      source: "export default {};",
    };
  if (url.endsWith(".tsx") || url.endsWith("/src/api.ts")) {
    // Node tests use the API's default configuration; Vite normally supplies
    // import.meta.env. The actual HTTP/SSE implementation still runs.
    const source = (await readFile(new URL(url), "utf8")).replaceAll(
      "import.meta.env",
      "({})",
    );
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
      },
      fileName: fileURLToPath(url),
    });
    return { format: "module", shortCircuit: true, source: outputText };
  }
  return nextLoad(url, context);
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    const base = new URL(specifier, context.parentURL).href;
    for (const suffix of candidateSuffixes) {
      if (existsSync(fileURLToPath(new URL(base + suffix)))) {
        return nextResolve(base + suffix, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
