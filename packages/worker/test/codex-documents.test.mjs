import assert from "node:assert/strict";
import test from "node:test";
import { documentTexts } from "../dist/session/codex.js";
import { pdfWithPages } from "./pdf-fixture.mjs";

test("Codex gets a PDF as its text, told that layout and images are missing", async () => {
  const text = await documentTexts([
    { name: "invoice.pdf", bytes: pdfWithPages(["Invoice total: 42 EUR"]) },
    { name: "broken.pdf", bytes: Buffer.from("not a pdf") },
  ]);
  assert.match(
    text,
    /# Document invoice\.pdf \(PDF given to you as extracted text only\)/,
  );
  assert.match(text, /cannot see this PDF's layout or images/);
  assert.match(text, /Invoice total: 42 EUR/);
  assert.match(
    text,
    /No text could be extracted from broken\.pdf \(not_a_pdf\)/,
  );
  assert.equal(await documentTexts([]), "");
});
