/**
 * A column of explanation, choices and actions in a connector dialog or
 * panel: one steady gap, body type, paragraphs without their own margins.
 */
export const connectorStackClass =
  "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 text-sm leading-normal text-ink [&_p]:m-0";

/** A connector tab: its intro, alerts and sections stacked. */
export const connectorTabClass = "grid min-w-0 gap-4.5";
/** The intro line of a tab: its words on the left, its main action on the right. */
export const connectorIntroClass =
  "flex flex-wrap items-center justify-between gap-3";
export const connectorIntroCopyClass =
  "grid min-w-0 max-w-170 flex-[1_1_320px]";

/** A "view permissions" style disclosure: a chevron that turns when open. */
export const scopesDisclosureClass = "group min-w-0 text-xs";
export const scopesSummaryClass =
  "inline-flex cursor-pointer list-none items-center gap-1 rounded-xs text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--fdy-control-focus-soft) [&::-webkit-details-marker]:hidden [&>svg]:transition-transform [&>svg]:duration-100 group-open:[&>svg]:rotate-90";
export const scopesBodyClass = "grid min-w-0 gap-3 pt-2.5 pb-0.5 pl-4.5";
/** A monospace identifier inside a Cloudflare line. */
export const identifierClass = "font-mono text-2xs wrap-anywhere";
