import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);

const window = new Window();
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "MutationObserver",
  "Event",
  "MouseEvent",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const { referenceSizeLimit } =
  await import("../src/features/issue-detail/use-issue-contract.ts");
const { readPreviewMaterial } =
  await import("../src/features/issue-detail/evidence-api.ts");
const { EvidencePreview } =
  await import("../src/features/issue-detail/evidence-preview.tsx");

const MiB = 1024 * 1024;
const pdfBytes = Buffer.from("%PDF-1.4\n% a sealed reference\n%%EOF\n");
const pdfMaterial = {
  id: "mat_pdf",
  name: "guide.pdf",
  byteSize: pdfBytes.length,
  mimeType: "application/pdf",
  digest: `sha256:${createHash("sha256").update(pdfBytes).digest("hex")}`,
};

test("PDF references may be up to 32 MiB, by type or by name", () => {
  assert.equal(
    referenceSizeLimit({ name: "a.pdf", type: "application/pdf" }),
    32 * MiB,
  );
  assert.equal(referenceSizeLimit({ name: "A.PDF", type: "" }), 32 * MiB);
  assert.equal(
    referenceSizeLimit({ name: "a.png", type: "image/png" }),
    25 * MiB,
  );
  assert.equal(
    referenceSizeLimit({ name: "a.txt", type: "text/plain" }),
    512 * 1024,
  );
});

test("a sealed PDF can be previewed, within the PDF size limit", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  globalThis.fetch = async () => new Response(pdfBytes);
  const blob = await readPreviewMaterial("iss", pdfMaterial);
  assert.equal(blob.type, "application/pdf");
  await assert.rejects(
    readPreviewMaterial("iss", { ...pdfMaterial, byteSize: 33 * MiB }),
    /Preview unavailable/,
  );
});

test("opening a PDF material shows it in a titled frame from checked bytes", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return String(url).endsWith("/content")
      ? new Response(pdfBytes)
      : Response.json(pdfMaterial);
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(EvidencePreview, {
        issueId: "iss",
        materialId: "mat_pdf",
        label: "Brand guide",
      }),
    ),
  );
  const details = container.querySelector("details");
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new window.Event("toggle"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const frame = container.querySelector("iframe");
  assert.ok(frame, "a PDF frame is shown");
  assert.equal(frame.getAttribute("title"), "PDF preview: Brand guide");
  assert.match(frame.getAttribute("src"), /^blob:/);
  assert.ok(
    requests.every((url) => !frame.getAttribute("src").includes(url)),
    "the protected API URL never reaches the frame",
  );
  assert.ok(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent === "Open PDF in a new tab",
    ),
  );
  await act(async () => root.unmount());
});
