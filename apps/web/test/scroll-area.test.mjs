import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScrollArea } from "../src/components/ui/scroll-area.tsx";
import { DiffStat } from "../src/components/ui/diff-stat.tsx";

const render = (props) =>
  renderToStaticMarkup(
    createElement(ScrollArea, props, createElement("p", null, "body")),
  );

test("a scroll area is one native scroller whose content is its direct child", () => {
  const html = render({ className: "mine", viewportClassName: "inner" });
  assert.match(html, /^<div class="fdy-scroll-root mine">/);
  assert.match(
    html,
    /<div class="fdy-scroll-viewport inner" data-direction="vertical"><p>body<\/p><\/div>/,
  );
});

test("the direction says which axis scrolls", () => {
  for (const direction of ["vertical", "horizontal", "both", "none"])
    assert.match(
      render({ direction }),
      new RegExp(`data-direction="${direction}"`),
    );
});

test("a diff stat reads +added and minus removed", () => {
  const html = renderToStaticMarkup(
    createElement(DiffStat, { added: 13, removed: 41 }),
  );
  assert.match(html, /data-sign="added">\+13</);
  assert.match(html, /data-sign="removed">−41</);
});
