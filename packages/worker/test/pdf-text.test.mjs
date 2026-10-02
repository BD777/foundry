import assert from "node:assert/strict";
import test from "node:test";
import { extractPdfText, isPdf, pdfTextDocument } from "../dist/pdf-text.js";
import { pdfWithPages } from "./pdf-fixture.mjs";

test("a PDF's text is read page by page", async () => {
  const text = await extractPdfText(
    pdfWithPages(["Release checklist", "Second page text"]),
  );
  assert.equal(text.pageCount, 2);
  assert.deepEqual(text.pages, ["Release checklist", "Second page text"]);
  assert.equal(text.truncation, undefined);
  const document = pdfTextDocument("plan.pdf", text);
  assert.match(
    document,
    /^Text extracted from plan\.pdf \(2 pages\)\. Layout, images and scanned pages are not included\./,
  );
  assert.match(document, /--- Page 2 ---\nSecond page text/);
});

test("pages and characters beyond the limits are cut with a stated reason", async () => {
  const pages = await extractPdfText(pdfWithPages(["one", "two", "three"]), {
    pages: 2,
    characters: 1000,
  });
  assert.deepEqual(pages.pages, ["one", "two"]);
  assert.equal(pages.truncation, "Only the first 2 of 3 pages were read.");
  assert.match(
    pdfTextDocument("a.pdf", pages),
    /Only the first 2 of 3 pages were read\./,
  );

  const characters = await extractPdfText(pdfWithPages(["abcdef", "ghijkl"]), {
    pages: 10,
    characters: 8,
  });
  assert.deepEqual(characters.pages, ["abcdef", "gh"]);
  assert.match(
    characters.truncation,
    /cut at 8 characters, inside page 2 of 2/,
  );
});

test("something that is not a PDF is refused", async () => {
  assert.equal(isPdf(Buffer.from("hello")), false);
  await assert.rejects(extractPdfText(Buffer.from("not a pdf")), /not_a_pdf/);
});
