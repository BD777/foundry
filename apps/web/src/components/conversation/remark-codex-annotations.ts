/** An mdast node, as far as annotation references need. */
interface MarkdownSyntaxNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownSyntaxNode[];
}

const directivePattern =
  /:codex-annotation\{index="(\d+)"(?: id="([^"]*)")?\}/g;

/** A piece of text, or an annotation reference an answer's directive names. */
export type AnnotationSegment =
  | { kind: "text"; value: string }
  | { kind: "reference"; index: number; id: string | undefined };

/**
 * Splits text at the `:codex-annotation{…}` directives an answer uses to
 * address an annotation. A directive whose index is not a position stays text.
 */
export function splitAnnotationDirectives(text: string): AnnotationSegment[] {
  const segments: AnnotationSegment[] = [];
  let at = 0;
  for (const match of text.matchAll(directivePattern)) {
    const start = match.index ?? 0;
    const [directive, index = "", id = ""] = match;
    const position = Number(index);
    if (!Number.isInteger(position) || position < 1) continue;
    if (start > at)
      segments.push({ kind: "text", value: text.slice(at, start) });
    segments.push({ kind: "reference", index: position, id: id || undefined });
    at = start + directive.length;
  }
  if (at < text.length) segments.push({ kind: "text", value: text.slice(at) });
  return segments;
}

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

function referenceNode(
  reference: Extract<AnnotationSegment, { kind: "reference" }>,
): MarkdownSyntaxNode {
  return {
    type: "link",
    url: annotationReferenceHref(String(reference.index), reference.id ?? ""),
    children: [{ type: "text", value: String(reference.index) }],
  };
}

function referenceParts(node: MarkdownSyntaxNode): MarkdownSyntaxNode[] {
  const segments = splitAnnotationDirectives(node.value ?? "");
  if (!segments.some((segment) => segment.kind === "reference")) return [node];
  return segments.map((segment) =>
    segment.kind === "text"
      ? { type: "text", value: segment.value }
      : referenceNode(segment),
  );
}

/** A code span holding nothing but one directive: the marker the answer meant. */
function wholeDirective(
  node: MarkdownSyntaxNode,
): Extract<AnnotationSegment, { kind: "reference" }> | undefined {
  if (node.type !== "inlineCode") return undefined;
  const segments = splitAnnotationDirectives((node.value ?? "").trim());
  return segments.length === 1 && segments[0]?.kind === "reference"
    ? segments[0]
    : undefined;
}

/**
 * The `:codex-annotation{index="N" id="ID"}` directives an answer uses to
 * address an annotation become reference links, which the Markdown renderer
 * shows as numbered references. A code span that is only a directive becomes
 * one too; other code and existing links stay as written.
 */
export function remarkCodexAnnotations() {
  return (tree: MarkdownSyntaxNode) => {
    const visit = (node: MarkdownSyntaxNode) => {
      if (!node.children || opaqueTypes.has(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "text") return referenceParts(child);
        const whole = wholeDirective(child);
        return whole ? [referenceNode(whole)] : [child];
      });
      node.children.forEach(visit);
    };
    visit(tree);
  };
}
