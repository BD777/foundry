import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const sourceRoot = resolve("src");

const componentBoundaries = {
  "fdy-chat-conversation": new Set([
    "components/conversation/conversation.tsx",
  ]),
  "fdy-chat-composer": new Set(["components/conversation/conversation.tsx"]),
  "fdy-chat-queue": new Set(["components/conversation/conversation-queue.tsx"]),
  "fdy-chat-composer-footer": new Set(["components/ui/agent-composer.tsx"]),
  "fdy-chat-settings-trigger": new Set([
    "components/ui/agent-runtime-controls.tsx",
  ]),
  "fdy-chat-access-trigger": new Set([
    "components/ui/agent-runtime-controls.tsx",
  ]),
  "fdy-message-composer": new Set(["components/ui/message-composer.tsx"]),
  "fdy-composer-footer": new Set(["components/ui/message-composer.tsx"]),
  "fdy-composer-submit": new Set(["components/ui/message-composer.tsx"]),
  "fdy-composer-stop-icon": new Set(["components/ui/message-composer.tsx"]),
  "fdy-action-row": new Set(["components/ui/action-row.tsx"]),
  "fdy-asset-end-badge": new Set(["features/assets/asset-section.tsx"]),
  "fdy-badge": new Set(["components/ui/badge.tsx"]),
  "fdy-button": new Set(["components/ui/button.tsx"]),
  "fdy-check-row": new Set(["components/ui/checklist-row.tsx"]),
  "fdy-compare-key": new Set(["features/issue-detail/review-compare.tsx"]),
  "fdy-compare-swatch": new Set(["features/issue-detail/review-compare.tsx"]),
  "fdy-empty-state": new Set(["components/ui/empty-state.tsx"]),
  "fdy-feature-card": new Set(["features/skills/feature-card.tsx"]),
  "fdy-field": new Set(["components/ui/field.tsx"]),
  "fdy-text-diff": new Set(["components/ui/file-diff.tsx"]),
  "fdy-file-diff": new Set(["features/issue-detail/review-compare.tsx"]),
  "fdy-fact-grid": new Set(["features/assets/fact-grid.tsx"]),
  "fdy-foundry-shell": new Set(["components/ui/app-shell.tsx"]),
  "fdy-icon-box": new Set(["components/ui/icon-box.tsx"]),
  "fdy-info-row": new Set(["components/ui/info-row.tsx"]),
  "fdy-issues-screen": new Set(["features/issues/issue-workspace.tsx"]),
  "fdy-main": new Set(["components/ui/app-shell.tsx"]),
  "fdy-meta-pill": new Set([
    "features/issues/issue-card.tsx",
    "components/ui/meta-pill.tsx",
  ]),
  "fdy-notice-line": new Set(["components/ui/app-shell.tsx"]),
  "fdy-notice-stack": new Set(["components/ui/app-shell.tsx"]),
  "fdy-panel": new Set([
    "features/skills/feature-card.tsx",
    "components/ui/panel.tsx",
  ]),
  "fdy-preview-frame": new Set(["features/issue-detail/review-compare.tsx"]),
  "fdy-preview-skeleton": new Set(["features/issue-detail/review-compare.tsx"]),
  "fdy-priority-mark-dash": new Set(["features/issues/issue-card.tsx"]),
  "fdy-review-compare": new Set(["features/issue-detail/review-compare.tsx"]),
  "fdy-runs-filter": new Set(["features/runs/runs-table.tsx"]),
  "fdy-runtime-mark": new Set(["components/ui/runtime-mark.tsx"]),
  "fdy-scroll-root": new Set(["components/ui/scroll-area.tsx"]),
  "fdy-scroll-viewport": new Set(["components/ui/scroll-area.tsx"]),
  "fdy-scrollbar": new Set(["components/ui/scroll-area.tsx"]),
  "fdy-scroll-thumb": new Set(["components/ui/scroll-area.tsx"]),
  "fdy-scroll-corner": new Set(["components/ui/scroll-area.tsx"]),
  "fdy-segmented": new Set(["components/ui/segmented-control.tsx"]),
  "fdy-segment": new Set(["components/ui/segmented-control.tsx"]),
  "fdy-status-dot": new Set(["components/ui/meta-pill.tsx"]),
  "fdy-terminal-block": new Set(["components/ui/terminal-block.tsx"]),
  "fdy-timeline-item": new Set(["features/issue-detail/timeline-item.tsx"]),
  "fdy-view": new Set(["components/ui/app-shell.tsx"]),
  "fdy-workspace-strip-control": new Set([
    "features/issues/workspace-strip.tsx",
  ]),
};

const boundaryTokens = Object.keys(componentBoundaries).sort(
  (left, right) => right.length - left.length,
);

function listSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(path);
    }
    return path.endsWith(".tsx") ? [path] : [];
  });
}

function lineFor(source, index) {
  return source.slice(0, index).split("\n").length;
}

function hasClassToken(source, token) {
  return new RegExp(`(^|[^A-Za-z0-9_-])${token}([^A-Za-z0-9_-]|$)`).test(
    source,
  );
}

const failures = [];

for (const sourcePath of listSourceFiles(sourceRoot)) {
  const relativePath = relative(sourceRoot, sourcePath);
  const source = readFileSync(sourcePath, "utf8");

  for (const token of boundaryTokens) {
    if (!hasClassToken(source, token)) {
      continue;
    }

    const allowedFiles = componentBoundaries[token];
    if (allowedFiles.has(relativePath)) {
      continue;
    }

    const index = source.indexOf(token);
    failures.push({
      line: lineFor(source, index),
      path: relativePath,
      reason: `"${token}" must be emitted by its Foundry UI component`,
    });
  }
}

if (failures.length > 0) {
  console.error("Component boundary audit failed:");
  for (const failure of failures) {
    console.error(`- src/${failure.path}:${failure.line} ${failure.reason}`);
  }
  process.exit(1);
}

console.log("Component boundary audit passed.");
