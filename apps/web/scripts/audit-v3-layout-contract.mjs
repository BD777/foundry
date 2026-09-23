import postcss from "postcss";
import { enforceAuditBaseline } from "./audit-baseline.mjs";
import { readStyleSource, styleEntryPath } from "./style-source.mjs";

const css = readStyleSource();
const root = postcss.parse(css, { from: styleEntryPath });

const failures = [];

function splitSelectors(selector) {
  return selector
    .split(",")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

function ruleMatches(rule, selector) {
  return splitSelectors(rule.selector).includes(selector);
}

function ruleIsInAtRule(rule, atName, params) {
  let current = rule.parent;

  while (current && current !== root) {
    if (
      current.type === "atrule" &&
      current.name === atName &&
      current.params === params
    ) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

function ruleIsInMedia(rule, media) {
  return ruleIsInAtRule(rule, "media", media);
}

function ruleIsInScope(rule, { media, container } = {}) {
  if (!media && !container) {
    return rule.parent === root;
  }

  if (container) {
    return ruleIsInAtRule(rule, "container", container);
  }

  return ruleIsInMedia(rule, media);
}

function formattedValue(declaration) {
  const value = declaration.value.trim().replace(/\s+/g, " ");

  return declaration.important ? `${value} !important` : value;
}

function declarationsFor(selector, scope = {}) {
  const declarations = new Map();

  root.walkRules((rule) => {
    if (!ruleIsInScope(rule, scope) || !ruleMatches(rule, selector)) {
      return;
    }

    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, {
        line: declaration.source?.start?.line ?? rule.source?.start?.line ?? 1,
        value: formattedValue(declaration),
      });
    });
  });

  return declarations;
}

function scopeLabel(selector, { media, container } = {}) {
  if (container) {
    return `@container ${container} ${selector}`;
  }

  return media ? `@media ${media} ${selector}` : selector;
}

function expectDeclarations(selector, expected, options = {}) {
  const declarations = declarationsFor(selector, options);
  const label = scopeLabel(selector, options);

  for (const [property, expectedValue] of Object.entries(expected)) {
    const actual = declarations.get(property);

    if (!actual) {
      failures.push({
        line: 1,
        reason: `${label} must declare ${property}: ${expectedValue}`,
      });
      continue;
    }

    if (actual.value !== expectedValue) {
      failures.push({
        line: actual.line,
        reason: `${label} ${property} must be "${expectedValue}", got "${actual.value}"`,
      });
    }
  }
}

const contracts = [
  {
    selector: ":root",
    declarations: {
      "--fdy-paper": "#eef2f5",
      "--fdy-paper-side": "#eef2f5",
      "--fdy-paper-main": "#fff",
      "--fdy-paper-raised": "#fff",
      "--fdy-panel": "#fff",
      "--fdy-panel-soft": "#eef2f5",
      "--fdy-ink": "#33302a",
      "--fdy-ink-strong": "#26241f",
      "--fdy-ink-muted": "#5c6b78",
      "--fdy-ink-faint": "#6c675e",
      "--fdy-line": "#dde5ec",
      "--fdy-line-strong": "#d3dde6",
      "--fdy-brass": "#47617a",
      "--fdy-brass-dark": "#425d76",
      "--fdy-brass-soft": "#eef2f5",
      "--fdy-brass-line": "#d3dde6",
      "--fdy-green": "var(--fdy-success-text)",
      "--fdy-panel-radius": "12px",
      "--fdy-panel-radius-md": "9px",
      "--fdy-panel-shadow": "0 1px 2px rgba(32, 34, 38, 0.04)",
      color: "var(--fdy-ink)",
      background: "var(--fdy-paper)",
      "font-family":
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"',
      "letter-spacing": "0",
      "text-rendering": "optimizeLegibility",
      "-webkit-font-smoothing": "antialiased",
    },
  },
  {
    selector: "body",
    declarations: {
      margin: "0",
      overflow: "hidden",
      background: "var(--fdy-paper)",
    },
  },
  {
    selector: "button",
    declarations: {
      font: "inherit",
      cursor: "pointer",
    },
  },
  {
    selector: ".fdy-foundry-shell",
    declarations: {
      display: "flex",
      width: "100%",
      height: "100vh",
      overflow: "hidden",
      background: "var(--fdy-paper)",
    },
  },
  {
    selector: ".fdy-sidebar",
    declarations: {
      display: "flex",
      width: "262px",
      "min-height": "0",
      "box-sizing": "border-box",
      flex: "none",
      "flex-direction": "column",
      background: "var(--fdy-paper-side)",
      "border-right": "1px solid var(--fdy-line-strong)",
    },
  },
  {
    selector: ".fdy-main",
    declarations: {
      display: "flex",
      position: "relative",
      "min-width": "0",
      flex: "1",
      "flex-direction": "column",
      background: "var(--fdy-paper-main)",
    },
  },
  {
    selector: ".fdy-view",
    declarations: {
      "min-height": "0",
      flex: "1",
      overflow: "hidden",
    },
  },
  {
    selector: ".fdy-sidebar-brand",
    declarations: {
      display: "flex",
      "min-width": "0",
      "align-items": "center",
      gap: "10px",
      flex: "none",
      padding: "16px 18px 14px",
    },
  },
  {
    selector: ".fdy-sidebar-brand strong",
    declarations: {
      "min-width": "0",
      overflow: "hidden",
      color: "var(--fdy-ink)",
      "font-size": "16px",
      "font-weight": "700",
      "letter-spacing": "0",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-sidebar-brand code",
    declarations: {
      flex: "none",
      "margin-left": "auto",
      "font-size": "10px",
      "font-weight": "600",
      "letter-spacing": "0",
    },
  },
  {
    selector: ".fdy-sidebar-brand-icon",
    declarations: {
      display: "inline-flex",
      width: "28px",
      height: "28px",
      "align-items": "center",
      "justify-content": "center",
      "border-radius": "7px",
      overflow: "hidden",
    },
  },
  {
    selector: ".fdy-sidebar-brand-icon img",
    declarations: {
      display: "block",
      width: "100%",
      height: "100%",
      "object-fit": "contain",
    },
  },
  {
    selector: ".fdy-icon-box-composer",
    declarations: {
      width: "24px",
      height: "24px",
      "border-radius": "6px",
    },
  },
  {
    selector: ".fdy-icon-box-dark",
    declarations: {
      background: "var(--fdy-ink-strong)",
      color: "var(--fdy-paper-main)",
      "font-size": "11px",
      "font-weight": "700",
    },
  },
  {
    selector: ".fdy-sidebar-nav-scroll",
    declarations: {
      "min-height": "0",
      width: "100%",
      flex: "1",
    },
  },
  {
    selector: ".fdy-sidebar-nav",
    declarations: {
      display: "block",
      "min-width": "0",
      "box-sizing": "border-box",
      padding: "2px 12px 12px",
    },
  },
  {
    selector: ".fdy-sidebar-nav-section > span",
    declarations: {
      display: "flex",
      "align-items": "center",
      color: "var(--fdy-ink-faint)",
      "font-size": "10px",
      "font-weight": "600",
      "letter-spacing": "0",
      "line-height": "1",
      "text-transform": "uppercase",
      padding: "16px 12px 8px",
    },
  },
  {
    selector: ".fdy-sidebar-nav-link.fdy-button",
    declarations: {
      display: "flex",
      width: "100%",
      "min-width": "0",
      height: "auto",
      "min-height": "35px",
      "align-items": "center",
      "box-sizing": "border-box",
      "justify-content": "flex-start",
      gap: "10px",
      padding: "9px 12px 9px 9px",
      border: "0",
      "border-left": "3px solid transparent",
      "border-radius": "8px",
      color: "var(--fdy-ink-muted)",
      "font-size": "13.5px",
      "line-height": "1.25",
      "margin-bottom": "2px",
    },
  },
  {
    selector: '.fdy-sidebar-nav-link[data-state="active"]',
    declarations: {
      "border-left-color": "var(--fdy-brass)",
      background: "var(--fdy-brass-soft)",
      color: "var(--fdy-brass-dark)",
    },
  },
  {
    selector: ".fdy-sidebar-nav-icon",
    declarations: {
      display: "inline-flex",
      width: "18px",
      height: "18px",
      "align-items": "center",
      "justify-content": "center",
      flex: "none",
    },
  },
  {
    selector: ".fdy-sidebar-nav-label",
    declarations: {
      "min-width": "0",
      flex: "1",
      overflow: "hidden",
      "text-align": "left",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-sidebar-nav-link b",
    declarations: {
      flex: "none",
      "min-width": "19px",
      height: "19px",
      padding: "0 5px",
      "border-radius": "999px",
      background: "var(--fdy-brass-soft)",
      color: "var(--fdy-brass-dark)",
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "10.5px",
      "font-weight": "600",
      "line-height": "19px",
    },
  },
  {
    selector: ".fdy-sidebar-nav-link i",
    declarations: {
      display: "inline-flex",
      "min-width": "0",
      "align-items": "center",
      gap: "5px",
      flex: "none",
      color: "var(--fdy-brass-dark)",
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "10.5px",
      "font-style": "normal",
      "font-weight": "600",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-topbar",
    declarations: {
      display: "flex",
      width: "100%",
      height: "56px",
      "min-width": "0",
      "align-items": "center",
      "box-sizing": "border-box",
      gap: "14px",
      flex: "none",
      padding: "0 22px",
      "border-bottom": "1px solid var(--fdy-line)",
      background: "var(--fdy-topbar-bg)",
    },
  },
  {
    selector: ".fdy-topbar-title",
    declarations: {
      display: "flex",
      "min-width": "0",
      "max-width": "100%",
      "align-items": "baseline",
      flex: "0 1 auto",
      gap: "9px",
    },
  },
  {
    selector: ".fdy-topbar-title strong",
    declarations: {
      "min-width": "0",
      overflow: "hidden",
      color: "var(--fdy-ink)",
      "font-size": "14px",
      "font-weight": "600",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-topbar-title code",
    declarations: {
      "min-width": "0",
      "max-width": "min(360px, 44vw)",
      overflow: "hidden",
      "font-size": "11.5px",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-topbar-provider-chips",
    declarations: {
      display: "flex",
      "min-width": "0",
      "align-items": "center",
      flex: "none",
      gap: "8px",
      "margin-left": "auto",
    },
  },
  {
    selector: ".fdy-topbar-divider",
    declarations: {
      flex: "none",
      width: "1px",
      height: "24px",
      background: "var(--fdy-line)",
    },
  },
  {
    selector: ".fdy-topbar-action",
    declarations: {
      display: "inline-flex",
      "min-width": "0",
      "align-items": "center",
      flex: "none",
    },
  },
  {
    selector: ".fdy-topbar-action .fdy-button",
    declarations: {
      height: "34px",
      gap: "7px",
      padding: "0 14px",
      "border-radius": "8px",
      "font-size": "12.5px",
    },
  },
  {
    selector: ".fdy-notice-stack",
    declarations: {
      display: "flex",
      position: "absolute",
      top: "12px",
      right: "16px",
      "z-index": "40",
      width: "max-content",
      "max-width": "calc(100% - 32px)",
      "align-items": "flex-end",
      "flex-direction": "column",
      gap: "6px",
      "pointer-events": "none",
    },
  },
  {
    selector: ".fdy-notice-line",
    declarations: {
      display: "flex",
      "box-sizing": "border-box",
      overflow: "hidden",
      "align-items": "center",
      gap: "7px",
      width: "fit-content",
      "max-width": "100%",
      "min-height": "28px",
      padding: "0 10px",
      border: "1px solid var(--fdy-brass-line)",
      "border-radius": "999px",
      background: "var(--fdy-topbar-bg)",
      color: "var(--fdy-brass-dark)",
      "font-size": "12px",
      "font-weight": "600",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-notice-stack",
    declarations: {
      top: "10px",
      right: "12px",
      "max-width": "calc(100% - 24px)",
    },
  },
  {
    selector: ".fdy-button",
    declarations: {
      display: "inline-flex",
      gap: "7px",
      border: "1px solid transparent",
      "border-radius": "8px",
      "font-weight": "600",
      "letter-spacing": "0",
      "line-height": "1",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-button-sm",
    declarations: {
      height: "30px",
      padding: "0 10px",
      "font-size": "12px",
    },
  },
  {
    selector: ".fdy-button-md",
    declarations: {
      height: "34px",
      padding: "0 14px",
      "font-size": "12.5px",
    },
  },
  {
    selector: ".fdy-button-icon",
    declarations: {
      width: "28px",
      height: "28px",
      padding: "0",
    },
  },
  {
    selector: ".fdy-button-primary",
    declarations: {
      "border-color": "var(--fdy-brass-dark)",
      background: "var(--fdy-brass)",
      color: "var(--fdy-on-accent)",
      "box-shadow": "var(--fdy-panel-shadow)",
    },
  },
  {
    selector: ".fdy-action-row-md",
    declarations: {
      padding: "13px 18px",
    },
  },
  {
    selector: ".fdy-action-row-compact",
    declarations: {
      padding: "9px 10px",
    },
  },
  {
    selector: ".fdy-panel",
    declarations: {
      border: "1px solid var(--fdy-panel-border)",
      "border-radius": "var(--fdy-panel-radius)",
      background: "var(--fdy-panel)",
      "background-clip": "padding-box",
      "box-shadow": "var(--fdy-panel-shadow)",
    },
  },
  {
    selector: ".fdy-badge",
    declarations: {
      display: "inline-flex",
      gap: "6px",
      "border-radius": "999px",
      "font-weight": "600",
      "letter-spacing": "0",
      "line-height": "1",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-badge-sm",
    declarations: {
      height: "21px",
      padding: "0 9px",
      "font-size": "11px",
    },
  },
  {
    selector: ".fdy-badge-online",
    declarations: {
      "border-color": "var(--fdy-success-border)",
      background: "var(--fdy-green-soft)",
      color: "var(--fdy-success-text)",
    },
  },
  {
    selector: ".fdy-badge-brass",
    declarations: {
      "border-color": "var(--fdy-brass-line)",
      background: "var(--fdy-brass-soft)",
      color: "var(--fdy-brass-dark)",
    },
  },
  {
    selector: ".fdy-badge-warn",
    declarations: {
      "border-color": "var(--fdy-warning-border)",
      background: "var(--fdy-warning-surface)",
      color: "var(--fdy-warning-text)",
    },
  },
  {
    selector: ".fdy-badge-slate",
    declarations: {
      "border-color": "var(--fdy-info-border)",
      background: "var(--fdy-info-surface)",
      color: "var(--fdy-info-text)",
    },
  },
  {
    selector: ".fdy-segmented",
    declarations: {
      display: "inline-flex",
      width: "max-content",
      "max-width": "100%",
      border: "1px solid var(--fdy-line)",
      "border-radius": "8px",
      background: "var(--fdy-control-ghost-hover)",
    },
  },
  {
    selector: ".fdy-segmented-md",
    declarations: {
      gap: "2px",
      padding: "3px",
    },
  },
  {
    selector: ".fdy-segment",
    declarations: {
      display: "inline-flex",
      "align-items": "center",
      "justify-content": "center",
      flex: "none",
      gap: "6px",
      border: "0",
      "border-radius": "6px",
      background: "transparent",
      color: "var(--fdy-ink-muted)",
      "font-weight": "500",
      "line-height": "1",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-segment-md",
    declarations: {
      height: "24px",
      padding: "0 13px",
      "font-size": "12px",
    },
  },
  {
    selector: '.fdy-segment[data-state="on"]',
    declarations: {
      background: "var(--fdy-panel)",
      color: "var(--fdy-ink-strong)",
      "font-weight": "600",
      "box-shadow": "var(--fdy-panel-shadow)",
    },
  },
  {
    selector: ".fdy-workspace-strip",
    declarations: {
      display: "flex",
      width: "100%",
      "min-width": "0",
      "align-items": "center",
      "box-sizing": "border-box",
      gap: "10px",
      flex: "none",
      padding: "20px 24px 12px",
      "flex-wrap": "wrap",
    },
  },
  {
    selector: ".fdy-workspace-chip",
    declarations: {
      display: "inline-flex",
      "min-width": "0",
      "max-width": "100%",
      "align-items": "center",
      gap: "7px",
      overflow: "hidden",
      color: "var(--fdy-ink-strong)",
      "font-size": "12.5px",
      "font-weight": "600",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-workspace-strip > .fdy-mono-muted",
    declarations: {
      display: "inline-block",
      overflow: "hidden",
      "max-width": "min(340px, 100%)",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-branch-chip",
    declarations: {
      display: "inline-flex",
      "min-width": "0",
      "max-width": "100%",
      "align-items": "center",
      gap: "6px",
      overflow: "hidden",
      color: "var(--fdy-ink-muted)",
      "font-size": "11.5px",
      "font-weight": "500",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-branch-chip-dot",
    declarations: {
      width: "7px",
      height: "7px",
      flex: "none",
      "border-radius": "999px",
      background: "var(--fdy-green)",
    },
  },
  {
    selector: ".fdy-workspace-strip-muted",
    declarations: {
      "min-width": "0",
      overflow: "hidden",
      color: "var(--fdy-ink-faint)",
      "font-size": "11.5px",
      "font-weight": "500",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-workspace-strip-control",
    declarations: {
      flex: "none",
      "margin-left": "auto",
    },
  },
  {
    selector: ".fdy-message-composer",
    declarations: {
      "min-width": "0",
      "box-sizing": "border-box",
      padding: "10px 12px",
      "border-radius": "16px",
      background: "var(--fdy-panel)",
    },
  },
  {
    selector: ".fdy-message-composer .fdy-composer-submit",
    declarations: {
      width: "34px",
      height: "34px",
      "margin-left": "auto",
      flex: "none",
      "border-radius": "999px",
    },
  },
  {
    selector: ".fdy-issue-composer",
    declarations: {
      width: "calc(100% - 48px)",
      "max-width": "calc(100% - 48px)",
      "box-sizing": "border-box",
      flex: "none",
      margin: "0 24px",
    },
  },
  {
    selector: ".fdy-field-composer",
    declarations: {
      height: "44px",
      "min-height": "44px",
      flex: "1",
      padding: "2px 0 6px",
      "font-size": "14.5px",
      "line-height": "1.5",
    },
  },
  {
    selector: ".fdy-issue-composer-context",
    declarations: {
      display: "inline-flex",
      "min-width": "0",
      "max-width": "min(320px, 100%)",
      "align-items": "center",
      gap: "5px",
      overflow: "hidden",
      color: "var(--fdy-ink-faint)",
      "font-size": "11.5px",
      "font-weight": "500",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-board-scroll",
    declarations: {
      width: "100%",
      "min-height": "0",
      "box-sizing": "border-box",
      flex: "1",
      padding: "18px 24px 22px",
    },
  },
  {
    selector: ".fdy-board-scroll .fdy-scroll-viewport > div",
    declarations: {
      height: "100%",
      "min-width": "min-content",
    },
  },
  {
    selector: ".fdy-issue-board",
    declarations: {
      display: "flex",
      gap: "14px",
      width: "max-content",
      "min-width": "100%",
      height: "100%",
    },
  },
  {
    selector: ".fdy-issue-column",
    declarations: {
      display: "flex",
      width: "288px",
      "max-width": "288px",
      "min-width": "288px",
      "min-height": "0",
      flex: "none",
      "flex-direction": "column",
    },
  },
  {
    selector: ".fdy-issue-column-header",
    declarations: {
      display: "flex",
      "min-width": "0",
      "align-items": "center",
      gap: "8px",
      "box-sizing": "border-box",
      flex: "none",
      padding: "0 4px 10px",
    },
  },
  {
    selector: ".fdy-issue-column-stack",
    declarations: {
      display: "flex",
      "min-width": "0",
      "flex-direction": "column",
      gap: "9px",
      padding: "2px 4px 8px",
    },
  },
  {
    selector: ".fdy-issue-card.fdy-button",
    declarations: {
      display: "block",
      position: "relative",
      width: "100%",
      "max-width": "100%",
      "min-width": "0",
      height: "auto",
      "box-sizing": "border-box",
      overflow: "hidden",
      padding: "13px 14px",
      border: "1px solid var(--fdy-line)",
      "border-radius": "11px",
      background: "var(--fdy-panel)",
      "text-align": "left",
      "white-space": "normal",
      "box-shadow": "var(--fdy-panel-shadow)",
    },
  },
  {
    selector: ".fdy-issue-card.fdy-issue-card-review",
    declarations: {
      "border-color": "var(--fdy-brass-line)",
      "box-shadow": "var(--fdy-panel-shadow)",
    },
  },
  {
    selector: ".fdy-issue-card-topline",
    declarations: {
      display: "flex",
      "align-items": "center",
      gap: "8px",
      "justify-content": "space-between",
      "margin-bottom": "7px",
    },
  },
  {
    selector: ".fdy-issue-card-id",
    declarations: {
      color: "var(--fdy-ink-faint)",
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "10.5px",
      "font-weight": "600",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-issue-card-title",
    declarations: {
      display: "block",
      "margin-bottom": "5px",
      color: "var(--fdy-ink-strong)",
      "font-size": "13.5px",
      "font-weight": "600",
      "line-height": "1.35",
      "overflow-wrap": "anywhere",
      "text-overflow": "clip",
      "text-wrap": "pretty",
    },
  },
  {
    selector: ".fdy-issue-card-copy",
    declarations: {
      display: "-webkit-box",
      "min-width": "0",
      "margin-bottom": "11px",
      overflow: "hidden",
      color: "var(--fdy-ink-faint)",
      "font-size": "11.5px",
      "font-weight": "400",
      "line-height": "1.45",
      "overflow-wrap": "anywhere",
    },
  },
  {
    selector: ".fdy-issue-card-priority",
    declarations: {
      display: "inline-flex",
      "min-width": "0",
      "align-items": "center",
      gap: "4px",
      "font-size": "10.5px",
      "font-weight": "600",
      "line-height": "1",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-issue-card-footer",
    declarations: {
      display: "flex",
      "align-items": "center",
      gap: "8px",
      "max-width": "100%",
      color: "var(--fdy-ink-faint)",
      "font-size": "10px",
      "font-weight": "500",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-issue-review-line",
    declarations: {
      display: "flex",
      "min-width": "0",
      "align-items": "center",
      gap: "7px",
      "margin-bottom": "11px",
    },
  },
  {
    selector: ".fdy-issue-review-line > span:last-child",
    declarations: {
      "min-width": "0",
      overflow: "hidden",
      color: "var(--fdy-ink-faint)",
      "font-size": "11px",
      "font-weight": "500",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-issue-list-panel",
    declarations: {
      width: "calc(100% - 48px)",
      "max-width": "1000px",
      "box-sizing": "border-box",
      margin: "18px auto 40px",
      overflow: "hidden",
    },
  },
  {
    selector: ".fdy-issue-list-scroll",
    declarations: {
      width: "100%",
      overflow: "hidden",
    },
  },
  {
    selector: ".fdy-issue-list-head",
    declarations: {
      display: "grid",
      width: "100%",
      "box-sizing": "border-box",
      "grid-template-columns": "60px minmax(220px, 1fr) 132px 96px 84px",
      gap: "12px",
      "align-items": "center",
      "min-width": "676px",
      padding: "11px 18px",
      "font-size": "10px",
      "font-weight": "600",
      "letter-spacing": "0",
      "text-transform": "uppercase",
    },
  },
  {
    selector: ".fdy-issue-list-row.fdy-action-row",
    declarations: {
      display: "grid",
      width: "100%",
      "box-sizing": "border-box",
      "grid-template-columns": "60px minmax(220px, 1fr) 132px 96px 84px",
      gap: "12px",
      "align-items": "center",
      "min-width": "676px",
      position: "relative",
      "min-height": "45px",
      padding: "13px 18px",
      border: "0",
      "border-top": "1px solid var(--fdy-line-soft)",
      background: "transparent",
    },
  },
  {
    selector: ".fdy-issue-list-row > span",
    declarations: {
      "min-width": "0",
      overflow: "hidden",
      color: "var(--fdy-ink-faint)",
      "font-size": "11.5px",
      "font-weight": "600",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-callout",
    declarations: {
      display: "flex",
      gap: "12px",
      padding: "14px 16px",
      "border-radius": "12px",
    },
  },
  {
    selector: ".fdy-page-surface",
    declarations: {
      display: "flex",
      width: "100%",
      "flex-direction": "column",
      margin: "0 auto",
      padding: "26px 30px 60px",
    },
  },
  {
    selector: ".fdy-page-heading",
    declarations: {
      display: "flex",
      "align-items": "flex-end",
      gap: "14px",
    },
  },
  {
    selector: ".fdy-setup-screen",
    declarations: {
      height: "100%",
      "overflow-x": "hidden",
      "overflow-y": "auto",
      padding: "40px 30px 60px",
      animation: "fdyFade 0.25s ease both",
    },
  },
  {
    selector: ".fdy-setup-main",
    declarations: {
      "max-width": "720px",
      margin: "0 auto",
    },
  },
  {
    selector: ".fdy-setup-kicker",
    declarations: {
      display: "flex",
      "align-items": "center",
      gap: "10px",
      "margin-bottom": "8px",
      color: "var(--fdy-ink-faint)",
      "font-size": "12px",
      "font-weight": "600",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-setup-kicker span",
    declarations: {
      width: "9px",
      height: "9px",
      "border-radius": "999px",
      background: "var(--fdy-line-strong)",
    },
  },
  {
    selector: ".fdy-setup-screen h1",
    declarations: {
      margin: "0 0 8px",
      color: "var(--fdy-ink-strong)",
      "font-size": "24px",
      "font-weight": "700",
      "letter-spacing": "0",
      "line-height": "1.15",
    },
  },
  {
    selector: ".fdy-setup-main > p",
    declarations: {
      "max-width": "560px",
      margin: "0 0 26px",
      color: "var(--fdy-ink-muted)",
      "font-size": "14.5px",
      "line-height": "1.55",
    },
  },
  {
    selector: ".fdy-setup-steps",
    declarations: {
      display: "flex",
      "flex-direction": "column",
      gap: "14px",
    },
  },
  {
    selector: ".fdy-setup-step",
    declarations: {
      overflow: "hidden",
      padding: "18px 18px 16px",
    },
  },
  {
    selector: '.fdy-setup-step[data-state="muted"]',
    declarations: {
      padding: "18px",
      opacity: "0.62",
    },
  },
  {
    selector: ".fdy-setup-step-heading",
    declarations: {
      display: "flex",
      width: "100%",
      "align-items": "center",
      gap: "11px",
      "min-width": "0",
    },
  },
  {
    selector: ".fdy-setup-step-heading > span",
    declarations: {
      width: "24px",
      height: "24px",
      flex: "none",
      "border-radius": "999px",
      background: "var(--fdy-brass)",
      color: "var(--fdy-on-accent)",
      "font-size": "12px",
      "font-weight": "700",
      "line-height": "24px",
      "text-align": "center",
    },
  },
  {
    selector: ".fdy-setup-step-heading strong",
    declarations: {
      display: "block",
      "min-width": "0",
      overflow: "hidden",
      flex: "1",
      color: "var(--fdy-ink-strong)",
      "font-size": "14px",
      "font-weight": "600",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-setup-step-heading em",
    declarations: {
      display: "block",
      flex: "none",
      "max-width": "min(42%, 220px)",
      overflow: "hidden",
      color: "var(--fdy-ink-faint)",
      "font-size": "11px",
      "font-style": "normal",
      "font-weight": "500",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-setup-terminal",
    declarations: {
      margin: "12px 0 0",
    },
  },
  {
    selector: ".fdy-terminal-block",
    declarations: {
      "max-width": "100%",
      "border-radius": "9px",
      background: "var(--fdy-dark-surface)",
      color: "var(--fdy-dark-text)",
      "scrollbar-color": "var(--fdy-dark-muted) transparent",
    },
  },
  {
    selector: ".fdy-terminal-block code",
    declarations: {
      display: "block",
      padding: "13px 15px",
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "12.5px",
      "font-weight": "500",
      "line-height": "1.7",
    },
  },
  {
    selector: ".fdy-terminal-prompt",
    declarations: {
      color: "var(--fdy-dark-muted)",
    },
  },
  {
    selector: ".fdy-terminal-command",
    declarations: {
      "min-width": "0",
    },
  },
  {
    selector: ".fdy-terminal-line",
    declarations: {
      display: "block",
      "min-width": "0",
    },
  },
  {
    selector: ".fdy-setup-actions",
    declarations: {
      display: "flex",
      "min-width": "0",
      "align-items": "center",
      gap: "12px",
      "margin-top": "24px",
    },
  },
  {
    selector: ".fdy-setup-action-button.fdy-button",
    declarations: {
      height: "38px",
      gap: "8px",
      padding: "0 18px",
      "border-radius": "9px",
      "font-size": "13px",
    },
  },
  {
    selector: ".fdy-setup-action-dot",
    declarations: {
      width: "8px",
      height: "8px",
      flex: "none",
      "border-radius": "999px",
      background: "var(--fdy-success-text)",
    },
  },
  {
    selector: ".fdy-setup-actions > span",
    declarations: {
      "min-width": "0",
      "max-width": "340px",
      color: "var(--fdy-ink-faint)",
      "font-size": "11.5px",
      "font-weight": "500",
      "line-height": "1.4",
    },
  },
  {
    selector: ".fdy-page-surface-runs",
    declarations: {
      "max-width": "1040px",
      gap: "16px",
    },
  },
  {
    selector: ".fdy-runs-filter",
    declarations: {
      flex: "none",
      "border-radius": "9px",
    },
  },
  {
    selector: ".fdy-runs-filter .fdy-segment-md",
    declarations: {
      padding: "0 12px",
    },
  },
  {
    selector: ".fdy-runs-filter .fdy-segment",
    declarations: {
      "font-weight": "500",
    },
  },
  {
    selector: '.fdy-runs-filter .fdy-segment[data-state="on"]',
    declarations: {
      "font-weight": "600",
    },
  },
  {
    selector: ".fdy-runs-table-panel",
    declarations: {
      position: "relative",
      overflow: "hidden",
    },
  },
  {
    selector: ".fdy-runs-table-scroll",
    declarations: {
      width: "100%",
    },
  },
  {
    selector: ".fdy-runs-table-inner",
    declarations: {
      "min-width": "720px",
    },
  },
  {
    selector: ".fdy-runs-table-head",
    declarations: {
      padding: "11px 18px",
      "font-size": "10px",
      "font-weight": "600",
      "letter-spacing": "0",
      "text-transform": "uppercase",
    },
  },
  {
    selector: ".fdy-runs-table-row.fdy-action-row",
    declarations: {
      display: "grid",
      "grid-template-columns": "92px minmax(0, 1fr) 84px 128px 84px 108px",
      gap: "12px",
    },
  },
  {
    selector: ".fdy-runs-table-row.fdy-action-row",
    declarations: {
      display: "grid",
      "grid-template-columns": "92px minmax(0, 1fr) 84px 128px 84px 108px",
      gap: "12px",
      position: "relative",
      width: "100%",
      "min-height": "45px",
      "align-items": "center",
      padding: "13px 18px",
      border: "0",
      "border-top": "1px solid var(--fdy-line-soft)",
      background: "transparent",
    },
  },
  {
    selector: ".fdy-runs-table-row > span",
    declarations: {
      "min-width": "0",
      overflow: "hidden",
      color: "var(--fdy-ink-muted)",
      "font-size": "12px",
      "font-weight": "500",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-runs-table-row > span:first-child",
    declarations: {
      color: "var(--fdy-warning-text)",
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "11.5px",
      "font-weight": "600",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-runs-table-row > span:nth-child(5)",
    declarations: {
      "font-family": '"IBM Plex Mono", monospace',
      color: "var(--fdy-ink-faint)",
    },
  },
  {
    selector: ".fdy-runs-table-status-cell .fdy-badge",
    declarations: {
      height: "22px",
      "min-width": "96px",
      "justify-content": "flex-start",
    },
  },
  {
    selector: ".fdy-run-issue-cell",
    declarations: {
      display: "flex",
      "min-width": "0",
      "align-items": "baseline",
      gap: "8px",
    },
  },
  {
    selector: ".fdy-run-issue-cell strong",
    declarations: {
      "min-width": "0",
      overflow: "hidden",
      color: "var(--fdy-ink-strong)",
      "font-size": "13px",
      "font-weight": "600",
      "line-height": "1.3",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-run-issue-cell code",
    declarations: {
      color: "var(--fdy-ink-faint)",
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "10px",
      "font-weight": "500",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-run-phase-cell",
    declarations: {
      display: "inline-flex",
      "min-width": "0",
      "align-items": "center",
      gap: "6px",
    },
  },
  {
    selector: ".fdy-run-phase-cell i",
    declarations: {
      width: "6px",
      height: "6px",
      flex: "none",
      "border-radius": "999px",
      animation: "fdyPulse 1.5s ease-in-out infinite",
      background: "var(--fdy-warning-text)",
    },
  },
  {
    selector: ".fdy-run-runtime-cell",
    declarations: {
      display: "block",
      "min-width": "0",
      overflow: "hidden",
      color: "var(--fdy-ink-muted)",
      "font-size": "12px",
      "font-weight": "500",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-run-expanded",
    declarations: {
      padding: "14px 20px 6px 46px",
      "border-top": "1px solid var(--fdy-line-soft)",
      background: "var(--fdy-paper-raised)",
      animation: "fdyFade 0.2s ease both",
    },
  },
  {
    selector: ".fdy-run-trace-item",
    declarations: {
      display: "flex",
      "min-width": "0",
      gap: "11px",
    },
  },
  {
    selector: ".fdy-run-trace-rail",
    declarations: {
      display: "flex",
      "align-items": "center",
      flex: "none",
      "flex-direction": "column",
    },
  },
  {
    selector: ".fdy-run-trace-node",
    declarations: {
      width: "13px",
      height: "13px",
      flex: "none",
      border: "2px solid var(--fdy-success-border)",
      "border-radius": "999px",
      background: "var(--fdy-success-surface)",
    },
  },
  {
    selector: '.fdy-run-trace-item[data-state="active"] .fdy-run-trace-node',
    declarations: {
      "border-color": "var(--fdy-warning-text)",
      background: "var(--fdy-brass-soft)",
    },
  },
  {
    selector: ".fdy-run-trace-line",
    declarations: {
      width: "2px",
      "min-height": "12px",
      flex: "1",
      background: "var(--fdy-line)",
    },
  },
  {
    selector: ".fdy-run-trace-body",
    declarations: {
      "min-width": "0",
      flex: "1",
      "padding-bottom": "11px",
    },
  },
  {
    selector: ".fdy-run-trace-body strong",
    declarations: {
      display: "block",
      "min-width": "0",
      overflow: "hidden",
      color: "var(--fdy-ink)",
      "font-size": "12px",
      "font-weight": "500",
      "line-height": "1.3",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-run-trace-body code",
    declarations: {
      display: "block",
      "margin-top": "2px",
      overflow: "hidden",
      color: "var(--fdy-ink-faint)",
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "11px",
      "font-weight": "400",
      "line-height": "1.3",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-runs-mobile-list",
    declarations: {
      display: "none",
    },
  },
  {
    selector: ".fdy-runs-mobile-group",
    declarations: {
      "border-top": "1px solid var(--fdy-line-soft)",
    },
  },
  {
    selector: ".fdy-runs-mobile-group:first-child",
    declarations: {
      "border-top": "0",
    },
  },
  {
    selector: ".fdy-runs-mobile-card.fdy-action-row",
    declarations: {
      position: "relative",
      display: "flex",
      "align-items": "stretch",
      "flex-direction": "column",
      gap: "8px",
      width: "100%",
      padding: "14px 15px",
      border: "0",
      "border-radius": "0",
      background: "transparent",
      "text-align": "left",
    },
  },
  {
    selector: ".fdy-runs-mobile-topline",
    declarations: {
      display: "flex",
      "align-items": "center",
      "justify-content": "space-between",
      gap: "10px",
    },
  },
  {
    selector: ".fdy-runs-mobile-topline code",
    declarations: {
      color: "var(--fdy-warning-text)",
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "11px",
      "font-weight": "600",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-runs-mobile-topline .fdy-badge",
    declarations: {
      "min-width": "88px",
      "justify-content": "flex-start",
    },
  },
  {
    selector: ".fdy-runs-mobile-card > strong",
    declarations: {
      overflow: "hidden",
      color: "var(--fdy-ink-strong)",
      "font-size": "13.5px",
      "font-weight": "600",
      "line-height": "1.35",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-runs-mobile-issue",
    declarations: {
      color: "var(--fdy-ink-faint)",
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "11px",
      "font-weight": "600",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-runs-mobile-meta",
    declarations: {
      display: "grid",
      "grid-template-columns": "repeat(3, minmax(0, 1fr))",
      gap: "1px",
      overflow: "hidden",
      border: "1px solid var(--fdy-line)",
      "border-radius": "9px",
      background: "var(--fdy-line)",
    },
  },
  {
    selector: ".fdy-runs-mobile-meta > span",
    declarations: {
      display: "flex",
      "min-width": "0",
      "flex-direction": "column",
      gap: "6px",
      padding: "9px 10px",
      background: "var(--fdy-panel)",
    },
  },
  {
    selector: ".fdy-runs-mobile-meta em",
    declarations: {
      color: "var(--fdy-ink-faint)",
      "font-size": "9.5px",
      "font-style": "normal",
      "font-weight": "600",
      "letter-spacing": "0",
      "line-height": "1",
      "text-transform": "uppercase",
    },
  },
  {
    selector: ".fdy-runs-mobile-meta strong",
    declarations: {
      "min-width": "0",
      overflow: "hidden",
      color: "var(--fdy-ink)",
      "font-size": "12px",
      "font-weight": "600",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-runs-mobile-meta .fdy-run-runtime-cell",
    declarations: {
      width: "100%",
    },
  },
  {
    selector: ".fdy-page-surface-assets",
    declarations: {
      "max-width": "960px",
      gap: "0",
    },
  },
  {
    selector: ".fdy-page-surface-assets > .fdy-page-heading",
    declarations: {
      "margin-bottom": "20px",
    },
  },
  {
    selector: ".fdy-page-surface-assets > .fdy-section-label",
    declarations: {
      "margin-bottom": "9px",
    },
  },
  {
    selector: ".fdy-page-surface-assets > .fdy-device-asset-panel",
    declarations: {
      "margin-bottom": "22px",
    },
  },
  {
    selector: ".fdy-page-surface-assets > .fdy-asset-section",
    declarations: {
      "margin-bottom": "22px",
    },
  },
  {
    selector: ".fdy-page-surface-assets > .fdy-asset-section:last-child",
    declarations: {
      "margin-bottom": "0",
    },
  },
  {
    selector: ".fdy-page-surface-assets .fdy-page-heading-action .fdy-button",
    declarations: {
      height: "32px",
      gap: "7px",
      padding: "0 13px",
      "font-size": "12px",
    },
  },
  {
    selector: ".fdy-device-asset-panel",
    declarations: {
      overflow: "hidden",
      padding: "17px 18px",
    },
  },
  {
    selector: ".fdy-feature-card-row",
    declarations: {
      display: "flex",
      gap: "13px",
      padding: "15px 17px",
    },
  },
  {
    selector: ".fdy-issue-detail-screen",
    declarations: {
      display: "flex",
      height: "100%",
      "min-height": "0",
      animation: "fdyFade 0.25s ease both",
    },
  },
  {
    selector: ".fdy-issue-detail-main",
    declarations: {
      "min-width": "0",
      flex: "1",
    },
  },
  {
    selector: ".fdy-issue-detail-main .fdy-scroll-viewport",
    declarations: {
      "overflow-x": "hidden",
    },
  },
  {
    selector: ".fdy-issue-detail-content",
    declarations: {
      "min-width": "0",
      width: "min(860px, 100%)",
      "max-width": "860px",
      "box-sizing": "border-box",
      padding: "22px 26px 50px",
    },
  },
  {
    selector: ".fdy-issue-back-button.fdy-button",
    declarations: {
      "min-height": "14px",
      height: "auto",
      "align-items": "center",
      gap: "6px",
      margin: "0 0 14px",
      padding: "0",
      border: "0",
      background: "transparent",
      "box-shadow": "none",
      color: "var(--fdy-ink-faint)",
      "font-size": "12px",
      "font-weight": "500",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-issue-detail-header",
    declarations: {
      "min-width": "0",
      "max-width": "760px",
      "margin-bottom": "0",
    },
  },
  {
    selector: ".fdy-issue-detail-title-row",
    declarations: {
      display: "flex",
      "min-width": "0",
      "align-items": "center",
      gap: "11px",
      "flex-wrap": "wrap",
      "margin-bottom": "5px",
    },
  },
  {
    selector: ".fdy-issue-detail-title-row h1",
    declarations: {
      margin: "0",
      color: "var(--fdy-ink-strong)",
      "font-size": "20px",
      "font-weight": "700",
      "letter-spacing": "0",
      "line-height": "1.2",
      "overflow-wrap": "anywhere",
      "text-wrap": "pretty",
    },
  },
  {
    selector: ".fdy-issue-detail-title-row code",
    declarations: {
      flex: "none",
      color: "var(--fdy-ink-faint)",
      "font-size": "11.5px",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-issue-detail-title-row .fdy-badge",
    declarations: {
      "min-width": "140px",
      height: "22px",
      "justify-content": "flex-start",
    },
  },
  {
    selector: ".fdy-issue-detail-subtitle",
    declarations: {
      "max-width": "720px",
      margin: "0 0 20px",
      color: "var(--fdy-ink-faint)",
      "font-size": "12.5px",
      "line-height": "1.4",
      "overflow-wrap": "anywhere",
    },
  },
  {
    selector: ".fdy-issue-contract-body",
    declarations: {
      "min-width": "0",
      "max-width": "720px",
    },
  },
  {
    selector: ".fdy-issue-contract-section",
    declarations: {
      "margin-bottom": "20px",
    },
  },
  {
    selector: ".fdy-source-quote",
    declarations: {
      position: "relative",
      "box-sizing": "border-box",
      "max-width": "100%",
      margin: "0 0 20px",
      padding: "12px 15px",
      border: "0",
      "border-radius": "0 9px 9px 0",
      "font-size": "14px",
      "line-height": "1.55",
      "overflow-wrap": "anywhere",
      "text-wrap": "pretty",
    },
  },
  {
    selector: ".fdy-source-quote-brass",
    declarations: {
      "border-left": "3px solid var(--fdy-warning-border)",
      background: "var(--fdy-panel-soft)",
      color: "var(--fdy-warning-text)",
    },
  },
  {
    selector: ".fdy-inferred-task",
    declarations: {
      "max-width": "620px",
      margin: "0 0 20px",
      color: "var(--fdy-ink-strong)",
      "font-size": "14px",
      "line-height": "1.55",
      "overflow-wrap": "anywhere",
      "text-wrap": "pretty",
    },
  },
  {
    selector: ".fdy-detail-block",
    declarations: {
      "min-width": "0",
      width: "100%",
      "max-width": "760px",
      margin: "0 0 22px",
    },
  },
  {
    selector: ".fdy-compare-heading",
    declarations: {
      display: "flex",
      "align-items": "center",
      gap: "10px",
      "margin-bottom": "12px",
    },
  },
  {
    selector: ".fdy-compare-key",
    declarations: {
      display: "inline-flex",
      "align-items": "center",
      gap: "6px",
      flex: "none",
      color: "var(--fdy-ink-faint)",
      "font-size": "11px",
      "font-weight": "500",
      "line-height": "1",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-compare-swatch",
    declarations: {
      display: "inline-block",
      width: "10px",
      height: "10px",
      "border-radius": "3px",
    },
  },
  {
    selector: ".fdy-compare-grid",
    declarations: {
      display: "grid",
      width: "100%",
      "grid-template-columns": "1fr 1fr",
      gap: "14px",
      "min-width": "0",
      "margin-bottom": "22px",
    },
  },
  {
    selector: ".fdy-preview-frame",
    declarations: {
      "min-width": "0",
      "box-sizing": "border-box",
      overflow: "hidden",
      border: "1px solid var(--fdy-line)",
      "border-radius": "11px",
      background: "var(--fdy-panel)",
    },
  },
  {
    selector: '.fdy-preview-frame[data-tone="candidate"]',
    declarations: {
      "border-color": "var(--fdy-brass-line)",
      "box-shadow": "var(--fdy-shadow-floating)",
    },
  },
  {
    selector: ".fdy-preview-frame-bar",
    declarations: {
      display: "flex",
      "min-width": "0",
      "min-height": "28px",
      "align-items": "center",
      gap: "7px",
      "box-sizing": "border-box",
      padding: "8px 11px",
      "border-bottom": "1px solid var(--fdy-line-soft)",
      background: "var(--fdy-paper-raised)",
      color: "var(--fdy-ink-muted)",
      "font-size": "11.5px",
      "font-weight": "600",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-preview-frame-bar .fdy-compare-swatch",
    declarations: {
      width: "8px",
      height: "8px",
      "border-radius": "999px",
    },
  },
  {
    selector:
      '.fdy-preview-frame[data-tone="candidate"] .fdy-preview-frame-bar',
    declarations: {
      "border-bottom-color": "var(--fdy-warning-border)",
      background: "var(--fdy-panel-soft)",
      color: "var(--fdy-warning-text)",
    },
  },
  {
    selector: ".fdy-preview-frame-bar code",
    declarations: {
      "min-width": "0",
      "margin-left": "auto",
      overflow: "hidden",
      color: "var(--fdy-ink-faint)",
      "font-size": "10px",
      "font-weight": "500",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector:
      '.fdy-preview-frame[data-tone="candidate"] .fdy-preview-frame-bar code',
    declarations: {
      color: "var(--fdy-warning-text)",
    },
  },
  {
    selector: ".fdy-preview-skeleton",
    declarations: {
      "min-width": "0",
      "box-sizing": "border-box",
      padding: "14px",
      background: "var(--fdy-paper-main)",
    },
  },
  {
    selector: '.fdy-preview-skeleton[data-tone="candidate"]',
    declarations: {
      background: "var(--fdy-panel)",
    },
  },
  {
    selector: ".fdy-skel-grid",
    declarations: {
      display: "grid",
      "grid-template-columns": "1fr 1fr",
      gap: "9px",
      "min-width": "0",
      "margin-top": "14px",
    },
  },
  {
    selector: ".fdy-skel-grid span",
    declarations: {
      display: "block",
      "min-width": "0",
      height: "48px",
      border: "1px solid var(--fdy-line)",
      "border-radius": "6px",
      background: "var(--fdy-line)",
    },
  },
  {
    selector: ".fdy-candidate-change",
    declarations: {
      "min-width": "0",
      "margin-top": "14px",
      padding: "8px",
      border: "1.5px dashed var(--fdy-warning-border)",
      "border-radius": "7px",
      background: "var(--fdy-warning-surface)",
    },
  },
  {
    selector: ".fdy-candidate-change strong",
    declarations: {
      display: "block",
      "margin-bottom": "7px",
      color: "var(--fdy-warning-text)",
      "font-size": "9px",
      "font-weight": "600",
      "letter-spacing": "0",
      "line-height": "1",
      "text-transform": "uppercase",
    },
  },
  {
    selector: ".fdy-candidate-change .fdy-skel-grid",
    declarations: {
      "margin-top": "0",
    },
  },
  {
    selector: ".fdy-candidate-change .fdy-skel-grid span",
    declarations: {
      height: "34px",
      background: "var(--fdy-warning-surface)",
    },
  },
  {
    selector: ".fdy-file-diff",
    declarations: {
      "min-width": "0",
      "max-width": "100%",
      "box-sizing": "border-box",
      "margin-top": "0",
      padding: "14px 16px",
      "overflow-x": "hidden",
      "border-radius": "11px",
      background: "var(--fdy-dark-surface)",
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "12px",
      "font-weight": "500",
      "line-height": "1.9",
      color: "var(--fdy-dark-text)",
    },
  },
  {
    selector: ".fdy-file-diff-row",
    declarations: {
      display: "flex",
      width: "100%",
      "min-width": "0",
      "align-items": "center",
      gap: "10px",
      "min-height": "22px",
      color: "var(--fdy-dark-text)",
    },
  },
  {
    selector: ".fdy-file-diff-row span",
    declarations: {
      "min-width": "0",
      flex: "1",
      overflow: "hidden",
      color: "var(--fdy-dark-text)",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-file-diff-row b",
    declarations: {
      flex: "none",
      "min-width": "38px",
      color: "var(--fdy-diff-added)",
      "font-variant-numeric": "tabular-nums",
      "font-weight": "600",
      "text-align": "right",
    },
  },
  {
    selector: ".fdy-file-diff-row i",
    declarations: {
      flex: "none",
      "min-width": "34px",
      color: "var(--fdy-diff-removed)",
      "font-variant-numeric": "tabular-nums",
      "font-style": "normal",
      "text-align": "right",
    },
  },
  {
    selector: ".fdy-issue-inspector",
    declarations: {
      "min-width": "0",
      width: "316px",
      height: "100%",
      flex: "none",
      "box-sizing": "border-box",
      "overflow-y": "auto",
      padding: "22px 20px",
      "border-left": "1px solid var(--fdy-line)",
      background: "var(--fdy-paper-raised)",
    },
  },
  {
    selector: ".fdy-inspector-status-badge.fdy-badge",
    declarations: {
      "min-width": "150px",
      height: "22px",
    },
  },
  {
    selector: ".fdy-issue-inspector > .fdy-section-label",
    declarations: {
      "margin-bottom": "11px",
    },
  },
  {
    selector:
      ".fdy-issue-inspector > .fdy-inspector-status-badge + .fdy-inspector-block",
    declarations: {
      "margin-top": "18px",
    },
  },
  {
    selector: ".fdy-inspector-block",
    declarations: {
      "min-width": "0",
      "margin-top": "20px",
    },
  },
  {
    selector: ".fdy-inspector-block > .fdy-section-label",
    declarations: {
      "margin-bottom": "9px",
    },
  },
  {
    selector: ".fdy-inspector-block p",
    declarations: {
      margin: "6px 0 0",
      color: "var(--fdy-ink-faint)",
      "font-size": "11px",
      "line-height": "1.45",
      "overflow-wrap": "anywhere",
    },
  },
  {
    selector: ".fdy-confidence-meter",
    declarations: {
      display: "flex",
      width: "100%",
      "min-width": "0",
      "align-items": "center",
      gap: "10px",
    },
  },
  {
    selector: ".fdy-confidence-track",
    declarations: {
      "min-width": "0",
      height: "6px",
      flex: "1",
      overflow: "hidden",
      "border-radius": "999px",
      background: "var(--fdy-paper-side)",
    },
  },
  {
    selector: ".fdy-confidence-meter strong",
    declarations: {
      flex: "none",
      color: "var(--fdy-success-text)",
      "font-size": "12px",
      "font-weight": "600",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-check-list",
    declarations: {
      display: "flex",
      "min-width": "0",
      "flex-direction": "column",
      gap: "7px",
    },
  },
  {
    selector: ".fdy-check-list .fdy-check-row",
    declarations: {
      "align-items": "center",
      gap: "8px",
      "font-weight": "500",
    },
  },
  {
    selector: ".fdy-check-list .fdy-check-row-marker",
    declarations: {
      display: "inline-flex",
      width: "15px",
      height: "15px",
      "align-items": "center",
      "justify-content": "center",
      flex: "none",
      "border-radius": "999px",
    },
  },
  {
    selector: ".fdy-skill-chip-list",
    declarations: {
      display: "flex",
      "min-width": "0",
      "flex-wrap": "wrap",
      gap: "7px",
    },
  },
  {
    selector: ".fdy-skill-chip-list .fdy-meta-pill",
    declarations: {
      "min-width": "0",
      "max-width": "100%",
      overflow: "hidden",
      "text-overflow": "ellipsis",
    },
  },
  {
    selector: ".fdy-inspector-actions",
    declarations: {
      display: "flex",
      "min-width": "0",
      "flex-direction": "column",
      gap: "9px",
      "margin-top": "24px",
    },
  },
  {
    selector: ".fdy-inspector-actions .fdy-button",
    declarations: {
      width: "100%",
      overflow: "hidden",
      "border-radius": "9px",
      gap: "8px",
      "text-overflow": "ellipsis",
    },
  },
  {
    selector: ".fdy-runtime-pack-row",
    declarations: {
      display: "flex",
      "align-items": "center",
      gap: "9px",
      "flex-wrap": "wrap",
      margin: "9px 0",
    },
  },
  {
    selector: ".fdy-runtime-pack-row .fdy-meta-pill",
    declarations: {
      "font-size": "12.5px",
      "font-weight": "600",
    },
  },
  {
    selector: ".fdy-runtime-pack-row .fdy-meta-pill-mono",
    declarations: {
      "font-size": "12px",
    },
  },
  {
    selector: ".fdy-runtime-pack-row .fdy-meta-pill-caption",
    declarations: {
      "font-size": "11px",
    },
  },
  {
    selector:
      ".fdy-runtime-pack-row .fdy-meta-pill-mono .fdy-meta-pill-caption",
    declarations: {
      "font-size": "10.5px",
    },
  },
  {
    selector: ".fdy-with-label",
    declarations: {
      color: "var(--fdy-ink-faint)",
      "font-size": "12px",
      "font-weight": "600",
    },
  },
  {
    selector: ".fdy-detail-helper-copy",
    declarations: {
      "max-width": "620px",
      margin: "0 0 20px",
      color: "var(--fdy-ink-faint)",
      "font-size": "11.5px",
      "line-height": "1.5",
    },
  },
  {
    selector: ".fdy-timeline-heading",
    declarations: {
      display: "flex",
      "align-items": "center",
      gap: "10px",
      "margin-bottom": "12px",
    },
  },
  {
    selector: ".fdy-live-chip",
    declarations: {
      display: "inline-flex",
      "align-items": "center",
      gap: "6px",
      color: "var(--fdy-warning-text)",
      "font-size": "11px",
      "font-weight": "500",
    },
  },
  {
    selector: ".fdy-live-chip span",
    declarations: {
      width: "6px",
      height: "6px",
      "border-radius": "999px",
      background: "currentColor",
      animation: "fdyPulse 1.6s ease-in-out infinite",
    },
  },
  {
    selector: ".fdy-timeline-panel",
    declarations: {
      padding: "16px 18px 6px",
      "border-radius": "11px",
    },
  },
  {
    selector: ".fdy-timeline-item",
    declarations: {
      display: "flex",
      gap: "12px",
    },
  },
  {
    selector: ".fdy-timeline-node",
    declarations: {
      display: "inline-flex",
      width: "16px",
      height: "16px",
      "align-items": "center",
      "justify-content": "center",
      flex: "none",
      "margin-top": "1px",
      "border-radius": "999px",
    },
  },
  {
    selector: ".fdy-timeline-line",
    declarations: {
      width: "2px",
      "min-height": "16px",
      flex: "1",
      background: "var(--fdy-line)",
    },
  },
  {
    selector: ".fdy-timeline-item-done .fdy-timeline-node",
    declarations: {
      background: "var(--fdy-green-soft)",
      color: "var(--fdy-success-text)",
    },
  },
  {
    selector: ".fdy-timeline-item-active .fdy-timeline-node",
    declarations: {
      border: "2px solid var(--fdy-warning-text)",
      background: "var(--fdy-brass-soft)",
    },
  },
  {
    selector: ".fdy-timeline-item-active .fdy-timeline-node::before",
    declarations: {
      width: "7px",
      height: "7px",
      "border-radius": "999px",
      animation: "fdyPulse 1.3s ease-in-out infinite",
      background: "var(--fdy-warning-text)",
      content: '""',
    },
  },
  {
    selector: ".fdy-timeline-body",
    declarations: {
      "min-width": "0",
      flex: "1",
      "padding-bottom": "14px",
    },
  },
  {
    selector: ".fdy-timeline-body strong",
    declarations: {
      display: "block",
      color: "var(--fdy-ink-strong)",
      "font-size": "12.5px",
      "font-weight": "600",
      "line-height": "1.3",
    },
  },
  {
    selector: ".fdy-timeline-body p",
    declarations: {
      margin: "2px 0 0",
      color: "var(--fdy-ink-faint)",
      "font-size": "11.5px",
      "line-height": "1.3",
    },
  },
  {
    selector: ".fdy-criteria-panel",
    declarations: {
      "margin-top": "9px",
      padding: "6px 16px",
      overflow: "hidden",
    },
  },
  {
    selector: ".fdy-criteria-panel .fdy-check-row",
    declarations: {
      padding: "9px 0",
      "border-top": "1px solid var(--fdy-line-soft)",
    },
  },
  {
    selector: ".fdy-check-row",
    declarations: {
      color: "var(--fdy-ink)",
      "font-size": "13px",
      "line-height": "1.45",
    },
  },
  {
    selector: ".fdy-check-row-marker",
    declarations: {
      display: "inline-flex",
      width: "15px",
      height: "15px",
      "align-items": "center",
      "justify-content": "center",
      flex: "none",
      "margin-top": "2px",
      border: "1px solid var(--fdy-line-strong)",
      "border-radius": "5px",
      background: "var(--fdy-panel-soft)",
    },
  },
  {
    selector: ".fdy-inspector-detail-panel",
    declarations: {
      padding: "0",
      border: "0",
      "border-radius": "0",
      background: "transparent",
      "box-shadow": "none",
    },
  },
  {
    selector: ".fdy-context-priority-panel",
    declarations: {
      overflow: "hidden",
      "border-color": "var(--fdy-line)",
      "border-radius": "10px",
      background: "var(--fdy-panel)",
      "box-shadow": "none",
      padding: "0",
    },
  },
  {
    selector: ".fdy-context-priority-panel .fdy-info-row",
    declarations: {
      "padding-right": "11px",
      "padding-left": "11px",
    },
  },
  {
    selector: ".fdy-priority-row-primary",
    declarations: {
      background: "var(--fdy-panel-soft)",
    },
  },
  {
    selector: ".fdy-priority-row-primary .fdy-info-row-body strong",
    declarations: {
      color: "var(--fdy-warning-text)",
    },
  },
  {
    selector: ".fdy-priority-row-primary .fdy-info-row-body code",
    declarations: {
      color: "var(--fdy-warning-text)",
    },
  },
  {
    selector: ".fdy-priority-step",
    declarations: {
      display: "inline-flex",
      width: "17px",
      height: "17px",
      "align-items": "center",
      "justify-content": "center",
      "border-radius": "999px",
      background: "var(--fdy-panel-soft)",
      color: "var(--fdy-ink-muted)",
      "font-size": "10px",
      "font-weight": "700",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-priority-row-primary .fdy-priority-step",
    declarations: {
      background: "var(--fdy-brass)",
      color: "var(--fdy-on-accent)",
    },
  },
  {
    selector: ".fdy-pending-artifact-button.fdy-button",
    declarations: {
      height: "38px",
      "font-size": "12.5px",
    },
  },
  {
    selector: ".fdy-pending-artifact-button.fdy-button:disabled",
    declarations: {
      "border-style": "dashed",
      "border-color": "var(--fdy-line-strong)",
      background: "var(--fdy-panel)",
      color: "var(--fdy-ink-faint)",
      cursor: "default",
    },
  },
  {
    selector: ".fdy-danger-action.fdy-button",
    declarations: {
      height: "38px",
      color: "var(--fdy-ink-faint)",
      "font-size": "12.5px",
    },
  },
  {
    selector: ".fdy-device-asset-main",
    declarations: {
      display: "flex",
      "align-items": "flex-start",
      gap: "13px",
    },
  },
  {
    selector: ".fdy-icon-box-device",
    declarations: {
      width: "42px",
      height: "42px",
      "border-radius": "10px",
    },
  },
  {
    selector: ".fdy-icon-box-row",
    declarations: {
      width: "30px",
      height: "30px",
      "border-radius": "8px",
    },
  },
  {
    selector: ".fdy-device-asset-title",
    declarations: {
      display: "flex",
      "align-items": "center",
      gap: "9px",
      "flex-wrap": "wrap",
      "margin-bottom": "4px",
    },
  },
  {
    selector: ".fdy-device-asset-title strong",
    declarations: {
      color: "var(--fdy-ink-strong)",
      "font-size": "15px",
      "font-weight": "700",
      "line-height": "1",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-device-asset-title > span:last-child",
    declarations: {
      flex: "none",
      color: "var(--fdy-ink-faint)",
      "font-size": "11px",
      "font-weight": "500",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-device-asset-title .fdy-badge",
    declarations: {
      height: "22px",
      "min-width": "72px",
      "justify-content": "flex-start",
    },
  },
  {
    selector: ".fdy-device-asset-copy > code",
    declarations: {
      display: "block",
      "margin-bottom": "11px",
      color: "var(--fdy-ink-faint)",
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "11.5px",
      "font-weight": "500",
      "line-height": "1.4",
    },
  },
  {
    selector: ".fdy-device-asset-tags",
    declarations: {
      display: "flex",
      "flex-wrap": "wrap",
      gap: "7px",
    },
  },
  {
    selector: ".fdy-device-action-buttons",
    declarations: {
      display: "flex",
      gap: "6px",
    },
  },
  {
    selector: ".fdy-device-action-buttons .fdy-button",
    declarations: {
      width: "30px",
      height: "30px",
      border: "1px solid var(--fdy-line)",
      "border-radius": "7px",
      background: "var(--fdy-panel)",
      color: "var(--fdy-ink-faint)",
    },
  },
  {
    selector: ".fdy-device-asset-actions",
    declarations: {
      display: "flex",
      flex: "none",
      "flex-direction": "column",
      "align-items": "flex-end",
      gap: "9px",
    },
  },
  {
    selector: ".fdy-device-asset-actions code",
    declarations: {
      display: "block",
      "max-width": "180px",
      overflow: "hidden",
      color: "var(--fdy-ink-faint)",
      "font-size": "10.5px",
      "line-height": "1",
      "text-align": "right",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-fact-grid",
    declarations: {
      display: "grid",
      "grid-template-columns": "repeat(auto-fit, minmax(150px, 1fr))",
      gap: "1px",
      overflow: "hidden",
      border: "1px solid var(--fdy-line)",
      "border-radius": "9px",
      background: "var(--fdy-line)",
    },
  },
  {
    selector: ".fdy-fact-grid-cell",
    declarations: {
      padding: "10px 13px",
      background: "var(--fdy-panel)",
    },
  },
  {
    selector: ".fdy-fact-grid-md",
    declarations: {
      "margin-top": "15px",
    },
  },
  {
    selector: ".fdy-fact-grid-cell span",
    declarations: {
      display: "block",
      "margin-bottom": "5px",
      color: "var(--fdy-ink-faint)",
      "font-size": "9.5px",
      "font-weight": "600",
      "letter-spacing": "0",
      "line-height": "1",
      "text-transform": "uppercase",
    },
  },
  {
    selector: ".fdy-fact-grid-cell strong",
    declarations: {
      display: "block",
      "min-width": "0",
      overflow: "hidden",
      color: "var(--fdy-ink-strong)",
      "font-size": "13px",
      "font-weight": "600",
      "line-height": "1.3",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: '.fdy-fact-grid-cell strong[data-mono="true"]',
    declarations: {
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "12px",
    },
  },
  {
    selector: ".fdy-asset-section-panel",
    declarations: {
      overflow: "hidden",
      padding: "2px 16px",
    },
  },
  {
    selector: ".fdy-asset-section > .fdy-section-label",
    declarations: {
      "margin-bottom": "9px",
    },
  },
  {
    selector: ".fdy-asset-section-panel .fdy-info-row:first-child",
    declarations: {
      "border-top": "1px solid var(--fdy-line-soft)",
    },
  },
  {
    selector: ".fdy-capacity-bars",
    declarations: {
      display: "flex",
      flex: "none",
      gap: "3px",
      "max-width": "100%",
    },
  },
  {
    selector: ".fdy-capacity-bars span",
    declarations: {
      width: "8px",
      height: "18px",
      "border-radius": "2px",
      background: "var(--fdy-line)",
    },
  },
  {
    selector: '.fdy-capacity-bars span[data-state="used"]',
    declarations: {
      background: "var(--fdy-warning-text)",
    },
  },
  {
    selector: ".fdy-page-surface-settings",
    declarations: {
      "max-width": "860px",
      gap: "0",
    },
  },
  {
    selector: ".fdy-page-surface-settings > .fdy-page-heading",
    declarations: {
      "margin-bottom": "18px",
    },
  },
  {
    selector: ".fdy-page-surface-settings > .fdy-callout",
    declarations: {
      "margin-bottom": "22px",
    },
  },
  {
    selector: ".fdy-page-surface-settings > .fdy-section-label",
    declarations: {
      "margin-bottom": "4px",
    },
  },
  {
    selector: ".fdy-page-surface-settings > .fdy-helper-copy",
    declarations: {
      "max-width": "640px",
      margin: "0 0 12px",
    },
  },
  {
    selector: ".fdy-page-heading h1",
    declarations: {
      margin: "0 0 3px",
      color: "var(--fdy-ink-strong)",
      "font-size": "21px",
      "font-weight": "700",
      "letter-spacing": "0",
      "line-height": "1.1",
    },
  },
  {
    selector: ".fdy-page-heading p",
    declarations: {
      margin: "0",
      color: "var(--fdy-ink-muted)",
      "font-size": "13px",
      "font-weight": "400",
      "line-height": "1.4",
    },
  },
  {
    selector: ".fdy-callout-warning",
    declarations: {
      "margin-bottom": "22px",
      padding: "15px 17px",
      border: "1px solid var(--fdy-brass-line)",
      background: "var(--fdy-panel-soft)",
      color: "var(--fdy-brass-dark)",
    },
  },
  {
    selector: ".fdy-callout-warning .fdy-callout-icon",
    declarations: {
      width: "30px",
      height: "30px",
      background: "var(--fdy-brass-soft)",
      color: "var(--fdy-brass-dark)",
    },
  },
  {
    selector: ".fdy-callout-warning strong",
    declarations: {
      color: "var(--fdy-brass-dark)",
      "font-size": "13.5px",
    },
  },
  {
    selector: ".fdy-provider-settings-grid",
    declarations: {
      display: "grid",
      width: "100%",
      "align-items": "stretch",
      "grid-template-columns": "repeat(2, minmax(0, 1fr))",
      gap: "16px",
    },
  },
  {
    selector: ".fdy-provider-settings-card",
    declarations: {
      display: "flex",
      "min-height": "252px",
      "flex-direction": "column",
      overflow: "hidden",
      padding: "18px",
    },
  },
  {
    selector: ".fdy-provider-settings-card .fdy-feature-card-header",
    declarations: {
      "align-items": "center",
      gap: "11px",
    },
  },
  {
    selector: ".fdy-provider-status-badge",
    declarations: {
      height: "22px",
      "min-width": "82px",
      flex: "none",
      "justify-content": "flex-start",
    },
  },
  {
    selector: ".fdy-provider-settings-card .fdy-info-row",
    declarations: {
      padding: "9px 0",
      "border-top": "1px solid var(--fdy-line-soft)",
    },
  },
  {
    selector: ".fdy-provider-settings-card .fdy-info-row-end",
    declarations: {
      "max-width": "58%",
      "text-align": "right",
    },
  },
  {
    selector: ".fdy-provider-settings-title",
    declarations: {
      display: "flex",
      "min-width": "0",
      "align-items": "center",
      flex: "1 1 auto",
      gap: "11px",
    },
  },
  {
    selector: ".fdy-provider-settings-title .fdy-runtime-mark",
    declarations: {
      flex: "none",
    },
  },
  {
    selector: ".fdy-provider-settings-copy",
    declarations: {
      "min-width": "0",
      flex: "1 1 auto",
    },
  },
  {
    selector: ".fdy-provider-settings-title strong",
    declarations: {
      display: "block",
      color: "var(--fdy-ink-strong)",
      "font-size": "15px",
      "font-weight": "700",
      "line-height": "1",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-provider-settings-title em",
    declarations: {
      display: "block",
      "margin-top": "3px",
      color: "var(--fdy-ink-faint)",
      "font-size": "10.5px",
      "font-style": "normal",
      "font-weight": "500",
      "line-height": "1.3",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-provider-local-secret",
    declarations: {
      display: "inline-flex",
      "align-items": "center",
      gap: "6px",
      color: "var(--fdy-success-text)",
    },
  },
  {
    selector: ".fdy-provider-capabilities",
    declarations: {
      padding: "11px 0 4px",
      "border-top": "1px solid var(--fdy-line-soft)",
    },
  },
  {
    selector: ".fdy-provider-capabilities > span",
    declarations: {
      display: "block",
      "margin-bottom": "9px",
      color: "var(--fdy-ink-faint)",
      "font-size": "12px",
      "font-weight": "500",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-provider-capability-list",
    declarations: {
      "align-items": "center",
    },
  },
  {
    selector: ".fdy-provider-capability-list .fdy-meta-pill",
    declarations: {
      height: "22px",
      "min-width": "0",
      "max-width": "100%",
      overflow: "hidden",
      padding: "0 9px",
      border: "1px solid var(--fdy-line)",
      "border-radius": "999px",
      background: "var(--fdy-panel-soft)",
      color: "var(--fdy-ink-muted)",
      "font-size": "11px",
      "font-weight": "500",
      "text-overflow": "ellipsis",
    },
  },
  {
    selector: ".fdy-provider-last-checked",
    declarations: {
      "min-width": "0",
      overflow: "hidden",
      color: "var(--fdy-ink-faint)",
      "font-size": "11px",
      "font-weight": "500",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-provider-settings-card > .fdy-feature-card-actions",
    declarations: {
      "min-width": "0",
      "align-items": "center",
      "justify-content": "flex-start",
      gap: "10px",
      "margin-top": "15px",
      "padding-top": "0",
      "border-top": "0",
    },
  },
  {
    selector: ".fdy-provider-actions",
    declarations: {
      width: "100%",
    },
  },
  {
    selector: ".fdy-provider-settings-card .fdy-button",
    declarations: {
      flex: "none",
      height: "32px",
      padding: "0 14px",
      "font-size": "12px",
    },
  },
  {
    selector:
      ".fdy-provider-settings-card .fdy-info-row-key-value .fdy-info-row-body strong",
    declarations: {
      "font-weight": "500",
      "line-height": "1",
    },
  },
  {
    selector:
      ".fdy-provider-settings-card .fdy-info-row-key-value .fdy-info-row-end",
    declarations: {
      "font-weight": "600",
      "line-height": "1",
    },
  },
  {
    selector:
      ".fdy-provider-settings-card .fdy-info-row-key-value .fdy-info-row-end strong",
    declarations: {
      "font-size": "12px",
      "font-weight": "600",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-page-surface-skills",
    declarations: {
      "max-width": "1000px",
      gap: "0",
    },
  },
  {
    selector: ".fdy-page-surface-skills > .fdy-page-heading",
    declarations: {
      "margin-bottom": "16px",
    },
  },
  {
    selector: ".fdy-page-surface-skills > .fdy-callout",
    declarations: {
      "margin-bottom": "24px",
    },
  },
  {
    selector: ".fdy-page-surface-skills .fdy-callout-info p",
    declarations: {
      color: "var(--fdy-ink-muted)",
    },
  },
  {
    selector: ".fdy-callout-info",
    declarations: {
      "margin-bottom": "24px",
      border: "1px solid var(--fdy-line)",
      background: "var(--fdy-info-surface)",
      color: "var(--fdy-info-text)",
    },
  },
  {
    selector: ".fdy-callout-info .fdy-callout-icon",
    declarations: {
      background: "var(--fdy-info-surface)",
      color: "var(--fdy-info-text)",
    },
  },
  {
    selector: ".fdy-skill-pack-section",
    declarations: {
      display: "flex",
      "flex-direction": "column",
      gap: "0",
    },
  },
  {
    selector:
      ".fdy-page-surface-skills > .fdy-skill-pack-section + .fdy-skill-pack-section",
    declarations: {
      "margin-top": "28px",
    },
  },
  {
    selector: ".fdy-section-count-label",
    declarations: {
      display: "flex",
      "align-items": "center",
      gap: "8px",
      "margin-bottom": "11px",
    },
  },
  {
    selector: ".fdy-section-count-label > span",
    declarations: {
      "min-width": "18px",
      height: "18px",
      padding: "0 5px",
      "border-radius": "999px",
      background: "var(--fdy-panel-soft)",
      color: "var(--fdy-ink-muted)",
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "10px",
      "font-weight": "600",
      "line-height": "18px",
      "text-align": "center",
    },
  },
  {
    selector: ".fdy-skill-pack-list",
    declarations: {
      display: "flex",
      "flex-direction": "column",
      gap: "10px",
    },
  },
  {
    selector: ".fdy-skill-registry-row",
    declarations: {
      display: "grid",
      "grid-template-columns": "34px minmax(0, 1fr) minmax(148px, auto)",
      gap: "13px",
      "align-items": "flex-start",
      padding: "15px 17px",
    },
  },
  {
    selector: '.fdy-skill-registry-row[data-tone="muted"]',
    declarations: {
      "border-style": "dashed",
      background: "var(--fdy-paper-raised)",
    },
  },
  {
    selector: ".fdy-feature-card-row.fdy-skill-registry-row",
    declarations: {
      display: "grid",
      "grid-template-columns": "34px minmax(0, 1fr) minmax(148px, auto)",
    },
  },
  {
    selector: ".fdy-icon-box-skill",
    declarations: {
      width: "34px",
      height: "34px",
      "border-radius": "9px",
    },
  },
  {
    selector: ".fdy-skill-registry-body",
    declarations: {
      "min-width": "0",
    },
  },
  {
    selector: ".fdy-skill-registry-title",
    declarations: {
      display: "flex",
      "align-items": "center",
      gap: "9px",
      "flex-wrap": "wrap",
      "margin-bottom": "5px",
    },
  },
  {
    selector: ".fdy-skill-registry-title h3",
    declarations: {
      "min-width": "0",
      overflow: "hidden",
      margin: "0",
      color: "var(--fdy-ink-strong)",
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "14.5px",
      "font-weight": "600",
      "line-height": "1",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-skill-registry-version",
    declarations: {
      flex: "none",
      color: "var(--fdy-ink-faint)",
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "11.5px",
      "font-weight": "500",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-skill-registry-title .fdy-meta-pill-xs",
    declarations: {
      height: "20px",
      gap: "5px",
      padding: "0 8px",
      "font-size": "10px",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-meta-pill-brass",
    declarations: {
      "border-color": "var(--fdy-warning-border)",
      background: "var(--fdy-warning-surface)",
      color: "var(--fdy-warning-text)",
    },
  },
  {
    selector: ".fdy-meta-pill-muted",
    declarations: {
      "border-color": "var(--fdy-line)",
      background: "var(--fdy-panel-soft)",
      color: "var(--fdy-ink-muted)",
    },
  },
  {
    selector: ".fdy-skill-registry-title .fdy-meta-pill-update",
    declarations: {
      "letter-spacing": "0",
    },
  },
  {
    selector: ".fdy-skill-registry-title .fdy-meta-pill-dot",
    declarations: {
      width: "6px",
      height: "6px",
    },
  },
  {
    selector: ".fdy-skill-registry-body > p",
    declarations: {
      margin: "0 0 6px",
      color: "var(--fdy-ink)",
      "font-size": "13px",
      "line-height": "1.5",
    },
  },
  {
    selector: ".fdy-skill-registry-detail",
    declarations: {
      color: "var(--fdy-ink-faint)",
      "font-size": "11.5px",
      "font-weight": "500",
      "line-height": "1.4",
    },
  },
  {
    selector: ".fdy-skill-registry-detail span",
    declarations: {
      color: "var(--fdy-ink-faint)",
      "font-weight": "600",
    },
  },
  {
    selector: ".fdy-skill-registry-actions",
    declarations: {
      display: "flex",
      "min-width": "0",
      "align-items": "flex-end",
      "flex-direction": "column",
      gap: "9px",
      "padding-left": "6px",
    },
  },
  {
    selector: ".fdy-skill-registry-actions > span",
    declarations: {
      display: "inline-flex",
      "align-items": "center",
      color: "var(--fdy-ink-faint)",
      "font-family": '"IBM Plex Mono", monospace',
      "font-size": "11px",
      "font-weight": "500",
      "line-height": "1",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-skill-registry-buttons",
    declarations: {
      display: "flex",
      "min-width": "0",
      "justify-content": "flex-end",
      "flex-wrap": "nowrap",
      gap: "7px",
    },
  },
  {
    selector: ".fdy-skill-registry-buttons .fdy-button",
    declarations: {
      "border-radius": "7px",
      padding: "0 12px",
      "font-size": "11.5px",
    },
  },
  {
    selector: '.fdy-skill-registry-row[data-tone="muted"] .fdy-button',
    declarations: {
      padding: "0 14px",
    },
  },
  {
    selector: ".fdy-feature-card-stack",
    declarations: {
      padding: "18px",
    },
  },
  {
    selector: ".fdy-feature-card-muted",
    declarations: {
      "border-color": "var(--fdy-line-strong)",
      "border-style": "dashed",
      background: "var(--fdy-paper-raised)",
      "box-shadow": "none",
    },
  },
  {
    selector: ".fdy-chat-screen",
    declarations: {
      display: "flex",
      height: "100%",
      animation: "fdyFade 0.25s ease both",
    },
  },
  {
    selector: ".fdy-chat-list",
    declarations: {
      display: "flex",
      width: "var(--fdy-chat-list-width, 270px)",
      "min-height": "0",
      flex: "none",
      "flex-direction": "column",
      "border-right": "1px solid var(--fdy-line)",
      background: "var(--fdy-chat-list-bg)",
    },
  },
  {
    selector: ".fdy-side-list-title",
    declarations: {
      display: "flex",
      "align-items": "center",
      gap: "8px",
      flex: "none",
      padding: "16px 16px 12px",
    },
  },
  {
    selector: ".fdy-side-list-title strong",
    declarations: {
      flex: "1",
      color: "var(--fdy-ink-strong)",
      "font-size": "13px",
      "font-weight": "700",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-side-list-title .fdy-button",
    declarations: {
      width: "26px",
      height: "26px",
      "border-radius": "7px",
      background: "var(--fdy-control-ghost-hover)",
      color: "var(--fdy-ink-muted)",
    },
  },
  {
    selector: ".fdy-chat-list-scroll .fdy-scroll-viewport",
    declarations: {
      padding: "0 10px 12px",
    },
  },
  {
    selector: ".fdy-chat-row.fdy-action-row",
    declarations: {
      position: "relative",
      width: "100%",
      "align-items": "center",
      gap: "9px",
      "margin-bottom": "3px",
      overflow: "hidden",
      padding: "6px 10px",
      "border-radius": "9px",
    },
  },
  {
    selector: ".fdy-chat-row-copy strong",
    declarations: {
      color: "var(--fdy-ink)",
      "font-size": "12.5px",
      "font-weight": "600",
      "line-height": "1.3",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-chat-row-copy span",
    declarations: {
      color: "var(--fdy-ink-faint)",
      "font-size": "10.5px",
      "font-weight": "500",
      "line-height": "1.3",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-chat-row em",
    declarations: {
      flex: "none",
      color: "var(--fdy-ink-faint)",
      "font-size": "10px",
      "font-style": "normal",
      "font-weight": "500",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-chat-thread",
    declarations: {
      display: "flex",
      "min-width": "0",
      "min-height": "0",
      flex: "1",
      "flex-direction": "column",
    },
  },
  {
    selector: ".fdy-chat-thread-header",
    declarations: {
      display: "flex",
      "align-items": "center",
      gap: "10px",
      flex: "none",
      padding: "13px 22px",
      "border-bottom": "1px solid var(--fdy-line)",
    },
  },
  {
    selector: ".fdy-chat-thread-title strong",
    declarations: {
      color: "var(--fdy-ink-strong)",
      "font-size": "14px",
      "font-weight": "600",
      "line-height": "1.3",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-readonly-badge",
    declarations: {
      gap: "6px",
      height: "24px",
      padding: "0 10px",
      "border-color": "var(--fdy-brass-line)",
      background: "var(--fdy-brass-soft)",
      color: "var(--fdy-brass-dark)",
      "letter-spacing": "0",
    },
  },
  {
    selector: ".fdy-chat-messages",
    declarations: {
      "min-height": "0",
      flex: "1",
    },
  },
  {
    selector: ".fdy-chat-messages .fdy-scroll-viewport",
    declarations: {
      padding: "20px 22px 40px",
    },
  },
  {
    selector: ".fdy-chat-message-wrap",
    declarations: {
      display: "flex",
      width: "100%",
      "max-width": "720px",
      "flex-direction": "column",
      gap: "22px",
      margin: "0 auto",
    },
  },
  {
    selector: ".fdy-chat-boundary-callout.fdy-callout",
    declarations: {
      gap: "11px",
      padding: "13px 15px",
      "margin-bottom": "4px",
    },
  },
  {
    selector: ".fdy-chat-boundary-callout .fdy-callout-icon",
    declarations: {
      width: "26px",
      height: "26px",
      "border-radius": "7px",
    },
  },
  {
    selector: ".fdy-chat-boundary-callout.fdy-callout strong",
    declarations: {
      "font-size": "12.5px",
    },
  },
  {
    selector: '.fdy-chat-message-card[data-role="user"]',
    declarations: {
      width: "fit-content",
      "max-width": "80%",
      "margin-left": "auto",
      padding: "10px 14px",
      border: "1px solid var(--fdy-line)",
      "border-radius": "13px 13px 4px 13px",
      background: "var(--fdy-control-ghost-hover)",
    },
  },
  {
    selector: '.fdy-chat-message-card[data-role="bot"]',
    declarations: {
      "max-width": "100%",
      "margin-bottom": "4px",
    },
  },
  {
    selector: ".fdy-chat-message-meta",
    declarations: {
      display: "flex",
      "align-items": "center",
      gap: "8px",
      "flex-wrap": "wrap",
      "margin-bottom": "8px",
    },
  },
  {
    selector: ".fdy-chat-message-meta .fdy-runtime-mark",
    declarations: {
      flex: "none",
    },
  },
  {
    selector: ".fdy-chat-message-meta strong",
    declarations: {
      color: "var(--fdy-ink-faint)",
      "font-size": "11.5px",
      "font-weight": "600",
      "line-height": "1",
    },
  },
  {
    selector: ".fdy-chat-message-copy",
    declarations: {
      margin: "0",
      color: "var(--fdy-ink)",
      "font-size": "14px",
      "line-height": "1.65",
      "text-wrap": "pretty",
    },
  },
  {
    selector: ".fdy-chat-issue-draft",
    declarations: {
      display: "flex",
      "align-items": "center",
      "flex-wrap": "wrap",
      gap: "10px",
      "margin-top": "12px",
      padding: "10px 13px",
      border: "1px solid var(--fdy-line)",
      "border-radius": "10px",
      background: "var(--fdy-panel-soft)",
    },
  },
  {
    selector: ".fdy-chat-issue-draft .fdy-button",
    declarations: {
      flex: "none",
      height: "30px",
      gap: "6px",
      padding: "0 12px",
      "border-radius": "7px",
      "font-size": "11.5px",
    },
  },
  {
    selector: ".fdy-chat-issue-draft > span",
    declarations: {
      "min-width": "0",
      flex: "1",
      color: "var(--fdy-ink-muted)",
      "font-size": "12px",
      "font-weight": "500",
      "line-height": "1.4",
    },
  },
  {
    selector: ".fdy-chat-composer",
    declarations: {
      "max-width": "var(--fdy-chat-content-max)",
      width:
        "calc( 100% - var(--fdy-chat-turn-gutter) - 2 * var(--fdy-chat-content-padding) )",
      margin: "-16px auto 20px",
    },
  },
  {
    selector: ".fdy-composer-footer",
    declarations: {
      display: "flex",
      "align-items": "center",
      gap: "10px",
      "min-width": "0",
    },
  },
  {
    selector: ".fdy-message-composer .fdy-field-chat",
    declarations: {
      "min-width": "0",
      padding: "4px 2px 12px",
      "font-size": "14px",
      "line-height": "1.5",
    },
  },
  {
    selector: ".fdy-chat-composer .fdy-meta-pill",
    declarations: {
      "min-width": "0",
      height: "26px",
      border: "0",
      background: "var(--fdy-control-ghost-hover)",
      color: "var(--fdy-ink-faint)",
    },
  },
  {
    selector: ".fdy-chat-safety-note",
    declarations: {
      display: "inline-flex",
      "min-width": "0",
      "align-items": "center",
      gap: "5px",
      color: "var(--fdy-ink-faint)",
      "font-size": "11px",
      "font-weight": "500",
      "line-height": "1",
      "white-space": "nowrap",
    },
  },
  {
    selector: ".fdy-message-composer .fdy-composer-submit",
    declarations: {
      width: "34px",
      height: "34px",
      "margin-left": "auto",
      "border-radius": "999px",
      "box-shadow": "none",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-foundry-shell",
    declarations: {
      height: "auto",
      "min-height": "100vh",
      "flex-direction": "column",
      overflow: "visible",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-sidebar",
    declarations: {
      width: "100%",
      "min-height": "auto",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-sidebar-nav-scroll .fdy-scroll-viewport",
    declarations: {
      height: "auto",
      "overflow-x": "auto !important",
      "overflow-y": "hidden !important",
      "scroll-padding": "12px",
      "scroll-snap-type": "x proximity",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-sidebar-nav",
    declarations: {
      display: "flex",
      width: "max-content",
      "min-width": "100%",
      gap: "6px",
      padding: "8px 12px 10px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-sidebar-nav-link.fdy-button",
    declarations: {
      width: "auto",
      height: "32px",
      "min-height": "32px",
      flex: "none",
      padding: "0 10px",
      "border-radius": "8px",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-topbar",
    declarations: {
      position: "sticky",
      top: "0",
      "z-index": "10",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issues-screen",
    declarations: {
      height: "auto",
      overflow: "visible",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-workspace-strip",
    declarations: {
      "align-items": "flex-start",
      "row-gap": "8px",
      padding: "14px 22px 10px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-page-heading",
    declarations: {
      "align-items": "flex-start",
      "flex-direction": "column",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-runs-table-scroll",
    declarations: {
      display: "none",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-runs-mobile-list",
    declarations: {
      display: "block",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-runs-mobile-card.fdy-action-row",
    declarations: {
      gap: "6px",
      padding: "12px 13px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-runs-mobile-meta",
    declarations: {
      "grid-template-columns": "repeat(3, minmax(0, 1fr))",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-runs-mobile-meta > span",
    declarations: {
      gap: "4px",
      padding: "7px 8px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-runs-mobile-card > strong",
    declarations: {
      overflow: "hidden",
      "overflow-wrap": "normal",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-runs-mobile-issue",
    declarations: {
      overflow: "hidden",
      "overflow-wrap": "normal",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-runs-mobile-meta .fdy-run-phase-cell",
    declarations: {
      width: "100%",
      "flex-wrap": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-runs-mobile-meta .fdy-run-runtime-cell",
    declarations: {
      overflow: "hidden",
      "overflow-wrap": "normal",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-runs-mobile-group .fdy-run-trace-body strong",
    declarations: {
      overflow: "hidden",
      "overflow-wrap": "normal",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-runs-mobile-group .fdy-run-trace-body code",
    declarations: {
      overflow: "hidden",
      "overflow-wrap": "normal",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-list-scroll",
    declarations: {
      display: "none",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-list-cards",
    declarations: {
      display: "block",
      width: "100%",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-list-card.fdy-action-row",
    declarations: {
      gap: "8px",
      padding: "12px 14px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-list-card > strong",
    declarations: {
      overflow: "hidden",
      "overflow-wrap": "normal",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-list-card-meta strong",
    declarations: {
      overflow: "hidden",
      "overflow-wrap": "normal",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-list-card-status .fdy-badge",
    declarations: {
      "min-width": "104px",
      "max-width": "104px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-list-card-meta",
    declarations: {
      "flex-wrap": "nowrap",
      gap: "12px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-list-card-meta > span",
    declarations: {
      flex: "0 1 auto",
      overflow: "hidden",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-list-card-meta > span:first-child",
    declarations: {
      flex: "1 1 auto",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-list-card-meta > span:last-child",
    declarations: {
      flex: "none",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-composer",
    declarations: {
      width: "calc(100% - 44px)",
      "max-width": "calc(100% - 44px)",
      margin: "0 22px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-composer-context",
    declarations: {
      flex: "1 1 auto",
      "max-width": "none",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-composer-status",
    declarations: {
      flex: "0 1 120px",
      "margin-left": "0",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-setup-screen",
    declarations: {
      padding: "28px 22px 46px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-setup-main > p",
    declarations: {
      "margin-bottom": "22px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-setup-steps",
    declarations: {
      gap: "12px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-setup-step",
    declarations: {
      padding: "15px 14px 14px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: '.fdy-setup-step[data-state="muted"]',
    declarations: {
      padding: "15px 14px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-setup-terminal .fdy-scroll-viewport",
    declarations: {
      "overflow-x": "hidden !important",
      "overflow-y": "hidden !important",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-terminal-block pre",
    declarations: {
      "min-width": "0",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-terminal-block code",
    declarations: {
      display: "grid",
      gap: "2px",
      padding: "12px 13px",
      "font-size": "12px",
      "line-height": "1.65",
      "white-space": "normal",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-terminal-line",
    declarations: {
      display: "grid",
      "grid-template-columns": "auto minmax(0, 1fr)",
      "column-gap": "6px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-terminal-command",
    declarations: {
      "overflow-wrap": "anywhere",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-setup-step-heading",
    declarations: {
      display: "grid",
      "grid-template-columns": "24px minmax(0, 1fr)",
      "align-items": "center",
      "column-gap": "11px",
      "row-gap": "6px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-setup-step-heading strong",
    declarations: {
      overflow: "visible",
      "line-height": "1.25",
      "text-overflow": "clip",
      "white-space": "normal",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-setup-step-heading em",
    declarations: {
      "grid-column": "2",
      "max-width": "none",
      overflow: "visible",
      "text-overflow": "clip",
      "white-space": "normal",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-setup-actions",
    declarations: {
      "align-items": "flex-start",
      "flex-direction": "column",
      gap: "8px",
      "margin-top": "18px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-setup-actions > span",
    declarations: {
      "max-width": "100%",
      "overflow-wrap": "anywhere",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-board-scroll",
    declarations: {
      "box-sizing": "border-box",
      width: "100%",
      "max-width": "100%",
      overflow: "visible",
      padding: "14px 22px 24px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-board",
    declarations: {
      width: "100%",
      "max-width": "100%",
      "min-width": "0",
      height: "auto",
      "flex-direction": "column",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-column",
    declarations: {
      width: "100%",
      "max-width": "100%",
      "min-width": "0",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-detail-screen",
    declarations: {
      display: "block",
      height: "auto",
      overflow: "visible",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-chat-screen",
    declarations: {
      display: "block",
      height: "auto",
      overflow: "visible",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-chat-list",
    declarations: {
      width: "100%",
      "max-height": "224px",
      flex: "none",
      "border-right": "0",
      "border-bottom": "1px solid var(--fdy-line)",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-chat-row-copy strong",
    declarations: {
      overflow: "hidden",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-chat-thread-header",
    declarations: {
      "align-items": "center",
      "flex-direction": "row",
      gap: "10px",
      padding: "13px 18px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-chat-thread-actions",
    declarations: {
      width: "auto",
      flex: "none",
      "flex-wrap": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-chat-messages .fdy-scroll-viewport",
    declarations: {
      padding: "16px 18px 38px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: '.fdy-chat-message-card[data-role="user"]',
    declarations: {
      "max-width": "100%",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-chat-conversation",
    declarations: {
      "--fdy-chat-content-padding": "18px",
    },
  },
  {
    selector: ".fdy-composer-footer",
    declarations: {
      "flex-wrap": "nowrap",
    },
  },
  {
    selector: ".fdy-message-composer",
    declarations: {
      container: "fdy-composer / inline-size",
    },
  },
  {
    container: "fdy-composer (max-width: 660px)",
    selector: ".fdy-message-composer .fdy-chat-agent-select",
    declarations: {
      "min-width": "0",
    },
  },
  {
    container: "fdy-composer (max-width: 660px)",
    selector: ".fdy-message-composer .fdy-chat-settings-menu",
    declarations: {
      "min-width": "0",
    },
  },
  {
    container: "fdy-composer (max-width: 660px)",
    selector: ".fdy-message-composer .fdy-chat-settings-trigger",
    declarations: {
      "min-width": "0",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-chat-composer-footer .fdy-meta-pill",
    declarations: {
      flex: "0 1 158px",
      "max-width": "158px",
      overflow: "hidden",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-chat-composer-footer .fdy-chat-safety-note",
    declarations: {
      flex: "0 1 auto",
      overflow: "hidden",
      "text-overflow": "ellipsis",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-detail-content",
    declarations: {
      "box-sizing": "border-box",
      width: "auto",
      "max-width": "none",
      margin: "0 24px",
      padding: "22px 0 42px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-inspector-desktop",
    declarations: {
      display: "none",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-inspector-mobile",
    declarations: {
      display: "block",
      margin: "16px 0 24px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-inspector-mobile .fdy-issue-inspector",
    declarations: {
      width: "auto",
      "max-width": "100%",
      height: "auto",
      "box-sizing": "border-box",
      overflow: "visible",
      padding: "14px",
      border: "1px solid var(--fdy-line)",
      "border-radius": "12px",
      background: "var(--fdy-paper-raised)",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-issue-inspector",
    declarations: {
      width: "auto",
      "max-width": "100%",
      height: "auto",
      "box-sizing": "border-box",
      overflow: "visible",
      "border-left": "0",
      "border-top": "1px solid var(--fdy-line)",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-compare-grid",
    declarations: {
      "grid-template-columns": "1fr",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-file-diff",
    declarations: {
      padding: "13px 14px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-file-diff-row",
    declarations: {
      display: "grid",
      "grid-template-columns": "minmax(0, 1fr) 38px 34px",
      "align-items": "flex-start",
      gap: "4px 8px",
      padding: "2px 0",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-provider-settings-grid",
    declarations: {
      "grid-template-columns": "1fr",
      gap: "12px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-provider-settings-card",
    declarations: {
      "min-height": "0",
      padding: "16px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-provider-settings-card .fdy-info-row-end",
    declarations: {
      "max-width": "100%",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-provider-settings-card > .fdy-feature-card-actions",
    declarations: {
      "align-items": "flex-start",
      "flex-direction": "column",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-provider-settings-card .fdy-feature-card-header",
    declarations: {
      "align-items": "center",
      "flex-wrap": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-provider-settings-title",
    declarations: {
      "align-self": "auto",
      flex: "1 1 auto",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-provider-settings-copy",
    declarations: {
      "min-width": "0",
      flex: "1 1 auto",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-provider-settings-title strong",
    declarations: {
      overflow: "hidden",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-provider-settings-title em",
    declarations: {
      overflow: "hidden",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-provider-settings-card > .fdy-provider-actions",
    declarations: {
      width: "100%",
      "align-items": "center",
      "flex-direction": "row",
      "flex-wrap": "wrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-device-asset-main",
    declarations: {
      display: "grid",
      "grid-template-columns": "42px minmax(0, 1fr)",
      "grid-template-areas": '"icon copy" ". actions"',
      "align-items": "flex-start",
      gap: "0 13px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-device-asset-actions",
    declarations: {
      width: "100%",
      "flex-direction": "row",
      "flex-wrap": "nowrap",
      "grid-area": "actions",
      "align-items": "center",
      "justify-content": "space-between",
      gap: "8px",
      padding: "7px 0 0",
      "border-top": "0",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-device-action-buttons",
    declarations: {
      flex: "none",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-device-action-buttons .fdy-button",
    declarations: {
      width: "28px",
      height: "28px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-device-asset-actions code",
    declarations: {
      width: "auto",
      "max-width": "none",
      height: "24px",
      flex: "1",
      padding: "0 8px",
      "border-radius": "8px",
      background: "var(--fdy-paper-raised)",
      overflow: "hidden",
      "line-height": "24px",
      "text-align": "left",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-device-asset-facts",
    declarations: {
      "grid-template-columns": "repeat(3, minmax(0, 1fr))",
      "margin-top": "12px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-device-asset-facts .fdy-fact-grid-cell",
    declarations: {
      padding: "8px 9px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-device-asset-facts .fdy-fact-grid-cell span",
    declarations: {
      "margin-bottom": "4px",
      "font-size": "8.5px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-device-asset-facts .fdy-fact-grid-cell strong",
    declarations: {
      overflow: "hidden",
      "font-size": "12px",
      "line-height": "1.2",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector:
      '.fdy-device-asset-facts .fdy-fact-grid-cell strong[data-mono="true"]',
    declarations: {
      "overflow-wrap": "normal",
      "font-size": "10.5px",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-asset-section-panel .fdy-info-row",
    declarations: {
      display: "grid",
      "grid-template-columns": "30px minmax(0, 1fr) minmax(66px, auto)",
      "grid-template-areas": '"icon body end"',
      "align-items": "center",
      gap: "9px",
      padding: "11px 0",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-asset-section-panel .fdy-info-row-end",
    declarations: {
      "grid-area": "end",
      "max-width": "100%",
      "justify-content": "flex-end",
      "flex-wrap": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-asset-section-panel .fdy-info-row-body strong",
    declarations: {
      overflow: "hidden",
      "overflow-wrap": "normal",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-asset-section-panel .fdy-capacity-bars",
    declarations: {
      gap: "2px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-asset-section-panel .fdy-capacity-bars span",
    declarations: {
      width: "6px",
      height: "16px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-asset-section-panel .fdy-info-row-end .fdy-badge",
    declarations: {
      "max-width": "78px",
      overflow: "hidden",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-asset-end-badge-92 .fdy-badge",
    declarations: {
      "min-width": "78px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-skill-registry-row",
    declarations: {
      "grid-template-columns": "34px minmax(0, 1fr)",
      gap: "8px 11px",
      padding: "13px 14px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-feature-card-row.fdy-skill-registry-row",
    declarations: {
      "grid-template-columns": "34px minmax(0, 1fr)",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-skill-registry-title",
    declarations: {
      gap: "6px 8px",
      "margin-bottom": "4px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-skill-registry-title .fdy-meta-pill-xs",
    declarations: {
      height: "18px",
      padding: "0 7px",
      "font-size": "9.5px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-skill-registry-version",
    declarations: {
      "font-size": "10.5px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-skill-registry-body > p",
    declarations: {
      display: "-webkit-box",
      overflow: "hidden",
      "-webkit-box-orient": "vertical",
      "-webkit-line-clamp": "2",
      "text-overflow": "ellipsis",
      "margin-bottom": "5px",
      "line-height": "1.4",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-skill-registry-detail",
    declarations: {
      display: "-webkit-box",
      overflow: "hidden",
      "-webkit-box-orient": "vertical",
      "-webkit-line-clamp": "2",
      "text-overflow": "ellipsis",
      "line-height": "1.35",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-skill-registry-actions",
    declarations: {
      "grid-area": "actions",
      "align-items": "center",
      "flex-direction": "row",
      "flex-wrap": "nowrap",
      gap: "6px",
      "justify-content": "space-between",
      "padding-left": "0",
      width: "100%",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-skill-registry-actions > span",
    declarations: {
      flex: "0 1 104px",
      "min-height": "0",
      "max-width": "104px",
      overflow: "hidden",
      "line-height": "30px",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-skill-registry-row > .fdy-skill-registry-actions > div",
    declarations: {
      "justify-content": "flex-end",
      "flex-wrap": "nowrap",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-skill-registry-buttons",
    declarations: {
      flex: "none",
      "flex-wrap": "nowrap",
      gap: "6px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-skill-registry-buttons .fdy-button",
    declarations: {
      height: "30px",
      padding: "0 9px",
      "font-size": "11px",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-skill-registry-title h3",
    declarations: {
      overflow: "visible",
      "font-size": "13.5px",
      "line-height": "1.15",
      "text-overflow": "clip",
      "white-space": "normal",
      "overflow-wrap": "anywhere",
    },
  },
  {
    media: "(max-width: 860px)",
    selector: ".fdy-feature-card-row",
    declarations: {
      display: "grid",
      "grid-template-columns": "34px minmax(0, 1fr)",
      "align-items": "flex-start",
    },
  },
  {
    media: "(max-width: 360px)",
    selector: ".fdy-runs-mobile-meta > span:nth-child(3)",
    declarations: {
      "grid-column": "auto",
    },
  },
];

for (const contract of contracts) {
  expectDeclarations(contract.selector, contract.declarations, {
    container: contract.container,
    media: contract.media,
  });
}

enforceAuditBaseline({
  auditName: "v3-layout",
  failureLabel: "V3 layout contract",
  failures,
  signature: (failure) => failure.reason,
});
