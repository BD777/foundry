/**
 * The media query for the narrow layout (no sidebar, the phone header), from
 * the theme's one breakpoint (`--breakpoint-sidebar` in styles/foundation.css),
 * so script and stylesheet switch at the same width. Without the stylesheet
 * (a test DOM) nothing is narrow.
 */
export function narrowLayoutQuery(): string {
  const width = getComputedStyle(document.documentElement)
    .getPropertyValue("--breakpoint-sidebar")
    .trim();
  return width ? `(width < ${width})` : "not all";
}
