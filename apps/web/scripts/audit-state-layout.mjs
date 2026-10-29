// Hovering, focusing or pressing a control must never move the content around
// it (DEV-081: a copy button after an inline path grew on hover and pushed
// the rest of the sentence). A :hover/:focus/:focus-within/:focus-visible/
// :active rule may change colour, opacity, shadow, outline or transform, but
// not the box size, spacing, font metrics, display or position. Two cases do
// not move anything and pass: a rule without the state already sets the same
// value (the state changes nothing), or the element is positioned
// absolute/fixed at rest (out of flow, as a floating affordance must be).
import { pathToFileURL } from "node:url";
import { readStyleSheets } from "./style-source.mjs";

const statePattern =
  /:has\((?:[^()]|\([^()]*\))*:(?:hover|focus|focus-within|focus-visible|active)\b(?:[^()]|\([^()]*\))*\)|:(?:hover|focus-within|focus-visible|focus|active)\b/g;

const layoutProperty =
  /^(?:(?:min-|max-)?(?:width|inline-size)|margin(?:-(?:left|right|inline(?:-start|-end)?))?|padding(?:-(?:left|right|inline(?:-start|-end)?))?|border(?:-(?:left|right|inline(?:-start|-end)?))?(?:-width)?|gap|column-gap|font|font-size|font-weight|font-family|font-stretch|letter-spacing|word-spacing|display|position|flex|flex-basis|flex-grow|flex-shrink|grid-template-columns)$/;

const outOfFlow = /^(?:absolute|fixed)$/;

function rules(css) {
  // Comments are blanked so line numbers stay right.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
  const found = [];
  for (const match of source.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]
      .split(",")
      .map((selector) => selector.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    const declarations = [
      ...match[2].matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;]+)/g),
    ].map(([, property, value]) => ({ property, value: value.trim() }));
    found.push({
      selectors,
      declarations,
      line: source
        .slice(0, match.index + match[0].length - match[0].trimStart().length)
        .split("\n").length,
    });
  }
  return found;
}

const withoutState = (selector) =>
  selector.replace(statePattern, "").replace(/\s+/g, " ").trim();

/** Every rule that resizes or moves an element on hover, focus or press. */
export function stateLayoutFailures(sheets) {
  const all = sheets.flatMap(({ path, css }) =>
    rules(css).map((rule) => ({ ...rule, path })),
  );
  // What each selector sets without a state: property -> values.
  const atRest = new Map();
  for (const rule of all)
    for (const selector of rule.selectors)
      for (const { property, value } of rule.declarations) {
        const set = atRest.get(selector) ?? new Map();
        atRest.set(selector, set);
        set.set(property, (set.get(property) ?? new Set()).add(value));
      }
  const failures = [];
  for (const rule of all) {
    const layout = rule.declarations.filter((d) =>
      layoutProperty.test(d.property),
    );
    if (!layout.length) continue;
    for (const selector of rule.selectors) {
      statePattern.lastIndex = 0;
      if (!statePattern.test(selector)) continue;
      const rest = atRest.get(withoutState(selector));
      if (
        [...(rest?.get("position") ?? [])].some((value) =>
          outOfFlow.test(value),
        )
      )
        continue;
      const moved = layout.filter((d) => !rest?.get(d.property)?.has(d.value));
      if (moved.length)
        failures.push({
          path: rule.path,
          line: rule.line,
          selector,
          properties: moved.map((d) => `${d.property}: ${d.value}`),
        });
    }
  }
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = stateLayoutFailures(readStyleSheets());
  if (failures.length) {
    console.error("State layout audit failed:");
    for (const failure of failures)
      console.error(
        `- ${failure.path}:${failure.line} "${failure.selector}" sets ${failure.properties.join("; ")}; ` +
          "hover/focus/active must not move content. Float the affordance (position: absolute from a zero-size anchor) or reserve its space at rest.",
      );
    process.exit(1);
  }
  console.log("State layout audit passed.");
}
