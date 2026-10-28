import { findFoundryIds, foundryIdKind } from "../../lib/foundry-ids";

/** An mdast node, as far as linking ids needs. */
interface MarkdownSyntaxNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownSyntaxNode[];
}

// Text inside these is never linked: a link's own label, a code block, raw
// HTML, a reference definition.
const opaqueTypes = new Set([
  "code",
  "definition",
  "html",
  "link",
  "linkReference",
]);

/**
 * A link naming a Foundry id, to `#<id>`: sanitizing keeps that target
 * while dropping custom properties, so markFoundryIdLinks (after it) marks
 * the link, and where it renders decides the page (or none, for a native
 * chat).
 */
function idLink(id: string, child: MarkdownSyntaxNode): MarkdownSyntaxNode {
  return { type: "link", url: `#${id}`, children: [child] };
}

function linkTextIds(node: MarkdownSyntaxNode): MarkdownSyntaxNode[] {
  const text = node.value ?? "";
  const ids = findFoundryIds(text);
  if (!ids.length) return [node];
  const parts: MarkdownSyntaxNode[] = [];
  let at = 0;
  for (const match of ids) {
    if (match.index > at)
      parts.push({ type: "text", value: text.slice(at, match.index) });
    parts.push(idLink(match.id, { type: "text", value: match.id }));
    at = match.index + match.id.length;
  }
  if (at < text.length) parts.push({ type: "text", value: text.slice(at) });
  return parts;
}

function linkChild(child: MarkdownSyntaxNode): MarkdownSyntaxNode[] {
  if (child.type === "text") return linkTextIds(child);
  if (child.type === "inlineCode") {
    const id = (child.value ?? "").trim();
    return foundryIdKind(id) ? [idLink(id, child)] : [child];
  }
  return [child];
}

/**
 * Foundry ids in an answer's prose, or alone in a code span, become links;
 * code blocks and existing links stay as written.
 */
export function remarkFoundryIds() {
  return (tree: MarkdownSyntaxNode) => {
    const visit = (node: MarkdownSyntaxNode) => {
      if (!node.children || opaqueTypes.has(node.type)) return;
      node.children = node.children.flatMap(linkChild);
      node.children.forEach(visit);
    };
    visit(tree);
  };
}
