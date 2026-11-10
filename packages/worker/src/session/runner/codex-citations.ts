import { basename } from "node:path";

const citation = /:codex-file-citation\{([^}]*)\}/g;
const attribute = /([\w-]+)="([^"]*)"/g;

/**
 * Codex's own client draws `:codex-file-citation{path="…"}` as a file card;
 * in Foundry the same citation is a Markdown link to the file, which the
 * answer's file references then open like any other path it names.
 */
export function codexCitationsAsLinks(text: string): string {
  if (!text.includes(":codex-file-citation{")) return text;
  return text.replace(citation, (directive, attributes: string) => {
    const path = [...attributes.matchAll(attribute)].find(
      ([, name]) => name === "path",
    )?.[2];
    if (!path) return directive;
    const label = basename(path).replace(/[[\]\\]/g, "\\$&");
    return `[${label}](<${path}>)`;
  });
}
