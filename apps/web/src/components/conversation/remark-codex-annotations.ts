/** An mdast node, as far as annotation references need. */
interface MarkdownSyntaxNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownSyntaxNode[];
}

const directivePattern =
  /:codex-annotation\{index="(\d+)"(?: id="([^"]*)")?\}/g;

// Text inside these keeps its characters: code, links, raw HTML, definitions.
const opaqueTypes = new Set([
  "code",
  "definition",
  "html",
  "inlineCode",
  "link",
  "linkReference",
]);

/** The href a reference link carries: its position and its annotation id. */
export const annotationReferencePrefix = "#codex-annotation:";

export function annotationReferenceHref(index: string, id: string): string {
  return `${annotationReferencePrefix}${index}:${id}`;
}

export function parseAnnotationReferenceHref(
  href: string,
): { index: number; id: string | undefined } | undefined {
  if (!href.startsWith(annotationReferencePrefix)) return undefined;
  const [index, id = ""] = href
    .slice(annotationReferencePrefix.length)
    .split(/:(.*)/s);
  const number = Number(index);
  if (!Number.isInteger(number) || number < 1) return undefined;
  return { id: id || undefined, index: number };
}

function referenceParts(node: MarkdownSyntaxNode): MarkdownSyntaxNode[] {
  const text = node.value ?? "";
  const matches = [...text.matchAll(directivePattern)];
  if (!matches.length) return [node];
  const parts: MarkdownSyntaxNode[] = [];
  let at = 0;
  for (const match of matches) {
    const start = match.index ?? 0;
    if (start > at) parts.push({ type: "text", value: text.slice(at, start) });
    const [, index = "", id = ""] = match;
    parts.push({
      type: "link",
      url: annotationReferenceHref(index, id),
      children: [{ type: "text", value: index }],
    });
    at = start + match[0].length;
  }
  if (at < text.length) parts.push({ type: "text", value: text.slice(at) });
  return parts;
}

/**
 * The `:codex-annotation{index="N" id="ID"}` directives an answer uses to
 * address an annotation become reference links, which the Markdown renderer
 * shows as numbered references. Code and existing links stay as written.
 */
export function remarkCodexAnnotations() {
  return (tree: MarkdownSyntaxNode) => {
    const visit = (node: MarkdownSyntaxNode) => {
      if (!node.children || opaqueTypes.has(node.type)) return;
      node.children = node.children.flatMap((child) =>
        child.type === "text" ? referenceParts(child) : [child],
      );
      node.children.forEach(visit);
    };
    visit(tree);
  };
}
