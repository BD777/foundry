/**
 * Text a PDF carries, read with Mozilla's pdf.js. Only the text layer: page
 * layout, images and scanned pages are not seen, and callers must say so.
 * Long documents are cut at a stated limit, never silently.
 */
export interface PdfText {
  pageCount: number;
  /** Text per page that was read, in page order. */
  pages: string[];
  /** Set when pages or characters were left out, saying exactly what. */
  truncation?: string;
}

export const pdfTextLimits = { pages: 200, characters: 400_000 };

export function isPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";
}

export async function extractPdfText(
  bytes: Uint8Array,
  limits = pdfTextLimits,
): Promise<PdfText> {
  if (!isPdf(bytes)) throw new Error("not_a_pdf");
  // Loaded on demand: pdf.js needs Node 22.13+, and only PDF work uses it.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = pdfjs.getDocument({
    // pdf.js takes ownership of (and detaches) the buffer it is given.
    data: new Uint8Array(bytes),
    // Text only: no fonts, rendering, scripts (XFA) or fetching.
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    stopAtErrors: false,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    verbosity: 0,
  });
  const document = await loading.promise;
  try {
    const pages: string[] = [];
    let characters = 0;
    let truncation: string | undefined;
    const readable = Math.min(document.numPages, limits.pages);
    for (let number = 1; number <= readable; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items)
        if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
      text = text.trim();
      if (characters + text.length > limits.characters) {
        pages.push(text.slice(0, limits.characters - characters));
        truncation = `Text was cut at ${limits.characters} characters, inside page ${number} of ${document.numPages}; later text was not read.`;
        break;
      }
      characters += text.length;
      pages.push(text);
    }
    if (!truncation && document.numPages > readable)
      truncation = `Only the first ${readable} of ${document.numPages} pages were read.`;
    return { pageCount: document.numPages, pages, truncation };
  } finally {
    await loading.destroy();
  }
}

/**
 * The extracted text as one readable document: page markers, and the limits
 * of what was read stated at the top.
 */
export function pdfTextDocument(name: string, text: PdfText): string {
  const header = [
    `Text extracted from ${name} (${text.pageCount} page${text.pageCount === 1 ? "" : "s"}). Layout, images and scanned pages are not included.`,
    ...(text.truncation ? [text.truncation] : []),
    ...(text.pages.every((page) => !page)
      ? [
          "No text layer was found; the PDF may be scanned images. Read the PDF itself to see its content.",
        ]
      : []),
  ];
  const pages = text.pages.map(
    (page, index) => `--- Page ${index + 1} ---\n${page}`,
  );
  return `${header.join("\n")}\n\n${pages.join("\n\n")}\n`;
}
