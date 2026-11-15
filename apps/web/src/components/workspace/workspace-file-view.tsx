import { Fragment, useState } from "react";
import { ExternalLink } from "lucide-react";
import { parse } from "yaml";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { SegmentedControl } from "../ui/segmented-control";
import { MarkdownContent } from "../conversation/markdown-content";
import { formatBytes } from "../../lib/format";

/**
 * A text file shown by its type (Markdown rendered, HTML with a sandboxed
 * preview, anything else as code): the chat's file panels and the
 * assistant's workspace files.
 */

export const markdownExtensions = new Set(["md", "markdown", "mdx"]);
export const htmlExtensions = new Set(["html", "htm"]);

export function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  return name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
}

export function formatFileSize(bytes: number): string {
  return formatBytes(bytes, { kbDigits: 1, trimZeros: true });
}

/** HTML file with live preview and source code switcher. */
export function HtmlFileView({
  content,
  path,
}: {
  content: string;
  path: string;
}) {
  const { t } = useTranslation("chat");
  const [mode, setMode] = useState<"preview" | "code">("preview");

  const openInNewWindow = () => {
    const blob = new Blob([content], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <SegmentedControl
          aria-label={t("detail.htmlModeLabel")}
          onValueChange={(val) => setMode(val as "preview" | "code")}
          options={[
            { label: t("detail.htmlPreview"), value: "preview" },
            { label: t("detail.htmlCode"), value: "code" },
          ]}
          size="sm"
          value={mode}
        />
        <Button
          className="inline-flex items-center gap-1.5 text-ink-muted"
          onClick={openInNewWindow}
          size="sm"
          variant="ghost"
        >
          <ExternalLink aria-hidden="true" size={14} />
          {t("detail.openInNewWindow")}
        </Button>
      </div>

      {mode === "preview" ? (
        <div className="h-[600px] min-h-[400px] w-full overflow-hidden rounded-lg border border-line bg-surface">
          <iframe
            className="block h-full w-full border-0 bg-surface"
            sandbox="allow-scripts allow-forms allow-popups"
            srcDoc={content}
            title={path}
          />
        </div>
      ) : (
        <div className="fdy-markdown">
          <pre className="text-xs">
            <code>{content}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * A Markdown file's leading YAML front matter, between `---` lines at its
 * very start (as SKILL.md and static-site tools write it), and the body.
 */
export function splitFrontMatter(content: string): {
  frontMatter?: string;
  body: string;
} {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    content,
  );
  return match
    ? { frontMatter: match[1], body: content.slice(match[0].length) }
    : { body: content };
}

/**
 * Front matter as `key: value` pairs when it is a YAML map whose values are
 * all scalars; undefined for anything else (lists, nested maps) or YAML that
 * does not parse, which is then shown as written.
 */
export function frontMatterFields(
  text: string,
): [string, string][] | undefined {
  let value: unknown;
  try {
    value = parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const fields: [string, string][] = [];
  for (const [key, field] of Object.entries(value)) {
    if (
      field !== null &&
      typeof field !== "string" &&
      typeof field !== "number" &&
      typeof field !== "boolean"
    )
      return undefined;
    fields.push([key, field === null ? "" : String(field)]);
  }
  return fields.length > 0 ? fields : undefined;
}

/** Front matter above the rendered body: fields, or its text as written. */
function FrontMatter({ text }: { text: string }) {
  const { t } = useTranslation("chat");
  const fields = frontMatterFields(text);
  const box = "mb-4 rounded-md border border-line px-3 py-2 text-xs";
  return fields ? (
    <dl
      aria-label={t("detail.frontMatter")}
      className={`${box} grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1`}
    >
      {fields.map(([key, value], index) => (
        <Fragment key={`${key}-${index}`}>
          <dt className="font-mono text-ink-muted">{key}</dt>
          <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{value}</dd>
        </Fragment>
      ))}
    </dl>
  ) : (
    <pre
      aria-label={t("detail.frontMatter")}
      className={`${box} overflow-x-auto font-mono`}
    >
      <code>{text}</code>
    </pre>
  );
}

/** Text by its type: Markdown rendered, HTML with preview, anything else as code. */
export function TextFileView({
  content,
  path,
}: {
  content: string;
  path: string;
}) {
  const ext = extensionOf(path);
  if (htmlExtensions.has(ext)) {
    return <HtmlFileView content={content} path={path} />;
  }
  if (markdownExtensions.has(ext)) {
    const { frontMatter, body } = splitFrontMatter(content);
    return (
      <div className="fdy-markdown">
        {frontMatter !== undefined ? <FrontMatter text={frontMatter} /> : null}
        <MarkdownContent>{body}</MarkdownContent>
      </div>
    );
  }
  return (
    <div className="fdy-markdown">
      <pre className="text-xs">
        <code>{content}</code>
      </pre>
    </div>
  );
}
