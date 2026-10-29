import { FileClock, FolderOpen } from "lucide-react";
import { useMemo, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import remarkBreaks from "remark-breaks";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
  type Components,
  type ExtraProps,
  type StreamdownProps,
} from "streamdown";
import { i18n } from "../../i18n";
import { foundryIdKind } from "../../lib/foundry-ids";
import { isAppHref } from "../../lib/in-app-navigation";
import { AppLink } from "../ui/app-link";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { fileIconForName } from "../ui/file-tree";
import { remarkAutolinkCjkBoundary } from "./remark-autolink-cjk-boundary";
import { devicePathReference } from "./file-path-candidate";
import { FoundryIdLink } from "./foundry-id-link";
import { remarkFoundryIds } from "./remark-foundry-ids";
import { LocalImage } from "./local-image";
import { markdownPlugins, useMarkdownMermaid } from "./markdown-mermaid";
import type {
  ConversationFileReference,
  ParsedImageTag,
} from "./conversation-types";

const streamingTextAnimation = {
  animation: "fadeIn" as const,
  duration: 140,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  maxBacklogMs: 120,
  sep: "word" as const,
  stagger: 12,
};

type MarkdownSegment =
  { kind: "image"; image: ParsedImageTag } | { kind: "text"; text: string };

function parseImageTagAttributes(
  attributes: string,
): ParsedImageTag | undefined {
  const pathMatch = attributes.match(
    /\bpath=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i,
  );
  const path = pathMatch?.[1] ?? pathMatch?.[2] ?? pathMatch?.[3];
  if (!path) {
    return undefined;
  }
  const nameMatch = attributes.match(
    /\bname=(?:"([^"]+)"|'([^']+)'|(\[[^\]]+]|[^\s>]+))/i,
  );
  const alt = (
    nameMatch?.[1] ??
    nameMatch?.[2] ??
    nameMatch?.[3] ??
    i18n.t("conversation:message.attachedImage")
  ).trim();
  return { alt, path };
}

function splitMarkdownImageTags(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const imageTagPattern = /<image\b([\s\S]*?)>\s*(?:<\/image>)?/gi;
  let lastIndex = 0;
  for (const match of text.matchAll(imageTagPattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ kind: "text", text: text.slice(lastIndex, index) });
    }
    const image = parseImageTagAttributes(match[1] ?? "");
    if (image) {
      segments.push({ kind: "image", image });
    } else {
      segments.push({ kind: "text", text: match[0] });
    }
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ kind: "text", text }];
}

function MarkdownImage({
  image,
  onPreview,
}: {
  image: ParsedImageTag;
  onPreview?: (image: ParsedImageTag) => void;
}) {
  return (
    <figure className="fdy-markdown-image">
      <LocalImage
        alt={image.alt}
        key={image.path}
        path={image.path}
        onPreview={onPreview ? () => onPreview(image) : undefined}
      />
      <figcaption>{image.alt}</figcaption>
    </figure>
  );
}

/** A hast node, as far as marking links needs. */
interface MarkdownTreeNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownTreeNode[];
}

/** A target with no scheme or root: `docs/plan.md`, `./a`, `../b`, `?q`. */
function isDocumentRelative(href: string): boolean {
  return href.trim() !== "" && !/^([a-z][a-z\d+.-]*:|[/#\\])/i.test(href);
}

/** A target from this origin's root: `/chats/sess_1`, not `//host/x`. */
function isRootRelative(href: string): boolean {
  return /^\/(?![/\\])/.test(href.trim());
}

// rehype-harden resolves links against a base and rewrites them, so the
// authored target of a document-relative or root-relative link is recorded
// before it runs.
function markRelativeLinks() {
  return (tree: MarkdownTreeNode) => {
    const visit = (node: MarkdownTreeNode) => {
      const href = node.properties?.href;
      if (node.tagName === "a" && typeof href === "string") {
        if (isDocumentRelative(href)) node.properties!.dataRelativeHref = href;
        else if (isRootRelative(href)) node.properties!.dataRootHref = href;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/**
 * Marks the links remarkFoundryIds made (`#<id>`): a page's id for
 * MarkdownLink, while a native chat's, which has no page, becomes text
 * titled with what it is. Runs after sanitizing, which drops the marks.
 */
function markFoundryIdLinks() {
  return (tree: MarkdownTreeNode) => {
    const visit = (node: MarkdownTreeNode) => {
      const href = node.properties?.href;
      const id =
        node.tagName === "a" && typeof href === "string" && href.startsWith("#")
          ? href.slice(1)
          : "";
      const kind = id ? foundryIdKind(id) : undefined;
      if (kind === "native") {
        node.tagName = "span";
        node.properties = {
          dataFoundryNativeId: id,
          title: i18n.t("conversation:message.nativeChatId"),
        };
      } else if (kind) node.properties!.dataFoundryId = id;
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

// Streamdown's own plugins in order. Harden blocks a relative link it cannot
// resolve, so it gets a base; that base never reaches the page because a
// relative link renders from its recorded target. Unsafe schemes stay blocked.
const markdownRehypePlugins: NonNullable<StreamdownProps["rehypePlugins"]> =
  Object.entries(defaultRehypePlugins).flatMap(([name, plugin]) => {
    if (name !== "harden" || !Array.isArray(plugin)) return [plugin];
    const [harden, options] = plugin;
    return [
      markFoundryIdLinks,
      markRelativeLinks,
      [harden, { ...options, defaultOrigin: "https://relative.invalid" }],
    ];
  });

function relativeLinkTarget(node: ExtraProps["node"]): string | undefined {
  const target = node?.properties.dataRelativeHref;
  return typeof target === "string" ? target : undefined;
}

function nodeProperty(
  node: ExtraProps["node"],
  name: "dataFoundryId" | "dataRootHref",
): string | undefined {
  const value = node?.properties[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * A link opens in a new tab; one to a page of this app (a Foundry id, or
 * an address on this origin) opens in place. A relative one, or a root
 * path that is no page here, stays text titled with its target instead of
 * sending the app to a broken route.
 */
function MarkdownLink({
  children,
  node,
  ...props
}: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  const foundryId = nodeProperty(node, "dataFoundryId");
  if (foundryId)
    return <FoundryIdLink id={foundryId}>{children}</FoundryIdLink>;
  const relative = relativeLinkTarget(node);
  if (relative !== undefined) return <span title={relative}>{children}</span>;
  const root = nodeProperty(node, "dataRootHref");
  if (root !== undefined)
    return isAppHref(root) ? (
      <AppLink href={root}>{children}</AppLink>
    ) : (
      <span title={root}>{children}</span>
    );
  // Harden marks every absolute link for a new tab; this one stays.
  const { rel: _rel, target: _target, ...inPlace } = props;
  if (props.href && isAppHref(props.href))
    return (
      <AppLink {...inPlace} href={props.href}>
        {children}
      </AppLink>
    );
  return (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

const markdownComponents: Components = {
  a: MarkdownLink,
  // Plain lists: `.fdy-markdown` owns their markers and vertical rhythm.
  ol: "ol",
  ul: "ul",
  li: "li",
};

/** Plain text of a rendered Markdown node (a code span or a link label). */
function nodeText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number")
    return String(children);
  return Array.isArray(children) ? children.map(nodeText).join("") : "";
}

/** Plain text of a Markdown syntax node, e.g. a link's label. */
function syntaxText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = node as { type?: string; value?: unknown; children?: unknown };
  if (value.type === "text" && typeof value.value === "string")
    return value.value;
  return Array.isArray(value.children)
    ? value.children.map(syntaxText).join("")
    : "";
}

function decodedHref(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

/**
 * A file or folder an answer names, opened in the chat's side panel. A file
 * not written yet keeps its link, marked by a clock: opening it says so.
 */
function FileReferenceButton({
  children,
  code,
  onOpen,
  reference,
}: {
  children: ReactNode;
  code: boolean;
  onOpen: (reference: ConversationFileReference) => void;
  reference: ConversationFileReference;
}) {
  const { t } = useTranslation(["conversation", "common"]);
  // The link opens the file; its copy button keeps the path one click away.
  // The button floats from a zero-width anchor at the path's end, so showing
  // it never moves the sentence (DEV-081). It follows the link in tab order.
  return (
    <span className="fdy-chat-file-reference-group">
      <Button
        className="fdy-chat-file-reference"
        data-pending={reference.pending ? "true" : undefined}
        onClick={() => onOpen(reference)}
        size="inline"
        title={t(
          reference.kind === "dir"
            ? "message.showFolder"
            : reference.pending
              ? "message.openPendingFile"
              : reference.device
                ? "message.openDeviceFile"
                : "message.openFile",
          { path: reference.path },
        )}
        variant="link"
      >
        {reference.kind === "dir" ? (
          <FolderOpen aria-hidden="true" size={13} />
        ) : reference.pending ? (
          <FileClock aria-hidden="true" size={13} />
        ) : (
          fileIconForName(reference.path, 13)
        )}
        {code ? <code>{children}</code> : <span>{children}</span>}
      </Button>
      <span className="fdy-chat-file-reference-anchor">
        <CopyButton
          className="fdy-chat-file-reference-copy"
          copiedLabel={t("common:actions.copied")}
          label={t("message.copyPath", { path: reference.path })}
          text={reference.path}
        />
      </span>
    </span>
  );
}

/**
 * Markdown components that turn the answer's paths into buttons: a code span
 * whose text, or a link whose authored target, is a path the device verified
 * when the turn ended. A name it could not resolve to exactly one existing
 * path stays text (DEV-081); only the device's owner also gets links to its
 * files outside the workspace, checked when opened. Every other link
 * renders as a MarkdownLink.
 */
function fileLinkComponents(
  references: ConversationFileReference[],
  onOpen: (reference: ConversationFileReference) => void,
  root: string | undefined,
  deviceFiles: boolean,
): Components {
  const byText = new Map(
    references.map((reference) => [reference.text, reference]),
  );
  const referenceFor = (text: string) =>
    byText.get(text) ??
    (deviceFiles ? devicePathReference(text, root) : undefined);
  return {
    ...markdownComponents,
    inlineCode: ({ children, node: _node, ...props }) => {
      const reference = referenceFor(nodeText(children).trim());
      return reference ? (
        <FileReferenceButton code onOpen={onOpen} reference={reference}>
          {children}
        </FileReferenceButton>
      ) : (
        <code {...props}>{children}</code>
      );
    },
    a: ({ children, href, node, ...props }) => {
      const root = nodeProperty(node, "dataRootHref");
      const app =
        nodeProperty(node, "dataFoundryId") !== undefined ||
        (root !== undefined && isAppHref(root));
      const target = relativeLinkTarget(node) ?? root ?? href;
      const reference =
        target && !app
          ? (referenceFor(target) ?? referenceFor(decodedHref(target)))
          : undefined;
      if (!reference)
        return (
          <MarkdownLink {...props} href={href} node={node}>
            {children}
          </MarkdownLink>
        );
      // A link around a code span keeps its code look without nesting.
      const only = node?.children.length === 1 ? node.children[0] : undefined;
      const onlyCode = only?.type === "element" && only.tagName === "code";
      return (
        <FileReferenceButton
          code={onlyCode}
          onOpen={onOpen}
          reference={reference}
        >
          {syntaxText(node) || href}
        </FileReferenceButton>
      );
    },
  };
}

// Streamdown stacks its top-level blocks with `space-y`; route that gap to the
// stylesheet's per-block flow space instead of a fixed 1rem.
const markdownFlowClassName = "space-y-[var(--fdy-markdown-flow-space)]";

// The same CJK syntax extensions used by @streamdown/cjk. Its bundled URL
// transformer also splits authored links, so keep our source-aware autolink
// rule instead. Emphasis must register before GFM; strikethrough after it.
const markdownRemarkPlugins = [
  remarkCjkFriendly,
  ...Object.values(defaultRemarkPlugins),
  remarkCjkFriendlyGfmStrikethrough,
  remarkAutolinkCjkBoundary,
  remarkFoundryIds,
];

// Text a person typed keeps its line breaks, as chat products do; agent
// answers stay standard Markdown, where a single newline is a soft break.
const typedTextRemarkPlugins = [...markdownRemarkPlugins, remarkBreaks];

function MarkdownText({
  children,
  components = markdownComponents,
  streaming,
  typedText,
}: {
  children: string;
  components?: Components;
  streaming: boolean;
  typedText: boolean;
}) {
  const { t } = useTranslation("conversation");
  const mermaid = useMarkdownMermaid();
  // Streaming mode splits the text into blocks so growing text re-renders only
  // its last block. Settled text is parsed once as a whole: cheaper to mount
  // whenever the transcript scrolls it back in, and references defined in a
  // later paragraph resolve.
  return (
    <Streamdown
      animated={streamingTextAnimation}
      className={markdownFlowClassName}
      components={components}
      isAnimating={streaming}
      // Streamdown retains the last successful SVG. A changed settled source
      // or theme needs a fresh renderer, including valid -> invalid edits.
      key={streaming ? "streaming" : `${mermaid.config?.theme}:${children}`}
      mode={streaming ? "streaming" : "static"}
      mermaid={mermaid}
      parseIncompleteMarkdown={streaming}
      // Incomplete diagram syntax stays readable as code until the turn ends.
      plugins={streaming ? undefined : markdownPlugins}
      rehypePlugins={markdownRehypePlugins}
      remarkPlugins={typedText ? typedTextRemarkPlugins : markdownRemarkPlugins}
      translations={t("diagram.controls", { returnObjects: true })}
      skipHtml
    >
      {children}
    </Streamdown>
  );
}

function preserveLiteralListMarkers(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^(\s*)(\d+)\.\s+/, "$1$2\\. ")
        .replace(/^(\s*)[-*+]\s+/, "$1\\- "),
    )
    .join("\n");
}

export function MarkdownContent({
  children,
  deviceFiles = false,
  fileReferences,
  fileRoot,
  onImagePreview,
  onOpenFileReference,
  streaming = false,
  typedText = false,
}: {
  children: ReactNode;
  /** Verified paths to link; nothing is linked while the text streams. */
  fileReferences?: ConversationFileReference[];
  /** The workspace folder: a path inside it links only once verified. */
  fileRoot?: string;
  /** The viewer owns the device: its files outside the workspace link too. */
  deviceFiles?: boolean;
  onImagePreview?: (image: ParsedImageTag) => void;
  onOpenFileReference?: (reference: ConversationFileReference) => void;
  streaming?: boolean;
  /** A person's own message: literal list markers and line breaks. */
  typedText?: boolean;
}) {
  const components = useMemo(
    () =>
      (fileReferences?.length || deviceFiles) &&
      onOpenFileReference &&
      !streaming
        ? fileLinkComponents(
            fileReferences ?? [],
            onOpenFileReference,
            fileRoot,
            deviceFiles,
          )
        : markdownComponents,
    [deviceFiles, fileReferences, fileRoot, onOpenFileReference, streaming],
  );
  // Streamdown keeps rendered blocks while their text is unchanged; new
  // links (the turn ended, its paths verified, a pending file written) need
  // a fresh render.
  const linked =
    components === markdownComponents
      ? ""
      : [
          `${deviceFiles ? "device:" : ""}${fileRoot ?? ""}`,
          ...(fileReferences ?? []).map(
            (reference) => `${reference.pending ? "?" : ""}${reference.text}`,
          ),
        ].join("\n");
  if (typeof children !== "string") {
    return <>{children}</>;
  }
  const content = typedText ? preserveLiteralListMarkers(children) : children;
  return (
    <>
      {splitMarkdownImageTags(content).map((segment, index) =>
        segment.kind === "image" ? (
          <MarkdownImage
            image={segment.image}
            key={`image-${index}`}
            onPreview={onImagePreview}
          />
        ) : segment.text.trim() ? (
          <MarkdownText
            components={components}
            key={`text-${index}:${linked}`}
            streaming={streaming}
            typedText={typedText}
          >
            {segment.text}
          </MarkdownText>
        ) : null,
      )}
    </>
  );
}
