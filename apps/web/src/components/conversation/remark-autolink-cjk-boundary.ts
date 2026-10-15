/** An mdast node, as far as ending an autolink needs. */
interface MarkdownSyntaxNode {
  type: string;
  url?: string;
  value?: string;
  title?: string | null;
  position?: { start: { offset?: number } };
  children?: MarkdownSyntaxNode[];
}

interface SourceFile {
  value?: unknown;
}

// CJK scripts, CJK symbols and punctuation (、。「」『』【】〔〕…), full-width
// forms (，；：！？（）) and the general punctuation Chinese text uses (—…“”‘’).
const cjkBoundary =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯—…‘-”]/u;

const literalPrefixes = new Set(["", "http://", "mailto:"]);

/** GFM's trailing rule: drop `?!.,:*_~` and a `)` that closes nothing. */
function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last && "?!.,:*_~".includes(last)) {
      end -= 1;
      continue;
    }
    if (last === ")") {
      const head = url.slice(0, end);
      const opened = head.split("(").length - 1;
      const closed = head.split(")").length - 1;
      if (closed > opened) {
        end -= 1;
        continue;
      }
    }
    return url.slice(0, end);
  }
}

/** The text of a link GFM recognised from a bare URL, `www.` or email. */
function literalAutolinkText(
  node: MarkdownSyntaxNode,
  source: string | undefined,
): { prefix: string; text: string } | undefined {
  if (node.type !== "link" || node.title || node.children?.length !== 1)
    return undefined;
  const [child] = node.children;
  if (child?.type !== "text" || typeof child.value !== "string")
    return undefined;
  const url = node.url ?? "";
  const text = child.value;
  if (!url.endsWith(text)) return undefined;
  const prefix = url.slice(0, url.length - text.length);
  if (!literalPrefixes.has(prefix)) return undefined;
  // `[label](url)` and `<url>` mark their own ends.
  const offset = node.position?.start.offset;
  if (
    source !== undefined &&
    offset !== undefined &&
    /[[<]/.test(source[offset] ?? "")
  )
    return undefined;
  return { prefix, text };
}

function splitLiteralAutolink(
  node: MarkdownSyntaxNode,
  source: string | undefined,
): MarkdownSyntaxNode[] | undefined {
  const literal = literalAutolinkText(node, source);
  if (!literal) return undefined;
  const cut = literal.text.search(cjkBoundary);
  if (cut < 0) return undefined;
  const linked = trimTrailingPunctuation(literal.text.slice(0, cut));
  const rest = literal.text.slice(linked.length);
  if (!/[^:/]/.test(linked.replace(/^[a-z][a-z\d+.-]*:\/\//i, "")))
    return [{ type: "text", value: literal.text }];
  return [
    {
      ...node,
      url: literal.prefix + linked,
      children: [{ type: "text", value: linked }],
    },
    { type: "text", value: rest },
  ];
}

/**
 * GFM ends a bare URL only at whitespace, so in Chinese text it swallows the
 * sentence after it. A bare URL here also ends before CJK text and full-width
 * punctuation; percent-encoded paths are ASCII and stay whole.
 */
export function remarkAutolinkCjkBoundary() {
  return (tree: MarkdownSyntaxNode, file: SourceFile) => {
    const source = typeof file.value === "string" ? file.value : undefined;
    const visit = (node: MarkdownSyntaxNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap(
        (child) => splitLiteralAutolink(child, source) ?? [child],
      );
      node.children.forEach(visit);
    };
    visit(tree);
  };
}
