/** Synthetic delayed/failed image reads; never calls a user's device. */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { i18n } from "../../src/i18n";
import { MarkdownContent } from "../../src/components/conversation/markdown-content";
import { ImagePreviewOverlay } from "../../src/components/conversation/image-preview-overlay";
import type { ParsedImageTag } from "../../src/components/conversation/conversation-types";
import "../../src/styles.css";
import "./chat-images.css";
const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") || "en");
document.documentElement.dataset.theme = params.get("theme") || "light";
const fetchOriginal = window.fetch.bind(window);
const attempts = new Map<string, number>();
window.fetch = async (url, init) => {
  if (!String(url).includes("/api/local-files/image"))
    return fetchOriginal(url, init);
  if (
    new URL(String(url), location.href).searchParams.get("variant") ===
    "placeholder"
  )
    return fetchOriginal("/foundry-icon.png", init);
  const path =
    new URL(String(url), location.href).searchParams.get("path") || "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, params.has("hold") ? 4000 : 250);
    init?.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
  const attempt = (attempts.get(path) || 0) + 1;
  attempts.set(path, attempt);
  document.documentElement.dataset.imageRequests = JSON.stringify(
    Object.fromEntries(attempts),
  );
  if (path.includes("missing"))
    return new Response("not found", { status: 404 });
  if (path.includes("offline")) return new Response("offline", { status: 409 });
  if (path.includes("slow") && attempt <= 2)
    return new Response("slow", { status: 504 });
  if (path.includes("interrupted") && attempt === 1)
    return new Response("slow", { status: 504 });
  return fetchOriginal("/foundry-icon.png", init);
};
function Fixture() {
  const [preview, setPreview] = useState<ParsedImageTag>();
  return (
    <main className="fdy-chat-images-fixture">
      <h1>DEV-051 · chat image delivery</h1>
      <p>Synthetic agent replies share the actual Markdown image component.</p>
      <article className="fdy-markdown">
        <MarkdownContent onImagePreview={setPreview}>
          {
            'A recovered image:\n<image path="/synthetic/.foundry/attachments/interrupted.png" name="Recovered screenshot">\nA slow device:\n<image path="/synthetic/.foundry/attachments/slow.png" name="Slow screenshot">\nAn offline device:\n<image path="/synthetic/.foundry/attachments/offline.png" name="Offline screenshot">\nA missing image:\n<image path="/synthetic/.foundry/attachments/missing.png" name="Missing screenshot">'
          }
        </MarkdownContent>
      </article>
      {preview ? (
        <ImagePreviewOverlay
          image={preview}
          onClose={() => setPreview(undefined)}
        />
      ) : null}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
