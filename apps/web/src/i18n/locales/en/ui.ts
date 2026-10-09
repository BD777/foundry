/** Generic shared controls: alerts, diffs, error fallbacks, sign-in relay. */
export const ui = {
  alert: {
    diagnosticDetails: "Diagnostic details",
  },
  errorBoundary: {
    title: "{{label}} could not be displayed",
    stillAvailable: "Other areas of Foundry are still available.",
    reload: "Reload page",
    tryAgain: "Try again",
  },
  fileDiff: {
    layout: "Diff layout",
    unified: "Unified",
    split: "Side by side",
    calculating: "Calculating this file’s diff…",
    noChanges: "No text changes.",
    addedLine: "Added line",
    removedLine: "Removed line",
    errors: {
      timedOut:
        "Diff timed out. Download the archives for external comparison.",
      display: "Could not display this diff.",
      worker: "Could not load the diff worker.",
      failed: "Could not calculate this file diff.",
      longLines:
        "This file contains very long lines. Download the archives for external comparison.",
      tooLarge:
        "This file is too large for inline diff. Download the archives for the complete contents.",
      timeLimit:
        "Diff computation reached its time limit. Download the archives to compare externally.",
      tooManyLines:
        "This diff has more than 5,000 lines. Download the archives to inspect all changes.",
    },
    /** The same failures for a file that can be opened instead. */
    fileErrors: {
      timedOut: "The diff took too long. View the file instead.",
      display: "Could not display this diff. View the file instead.",
      worker: "Could not load the diff worker. View the file instead.",
      failed: "Could not calculate this diff. View the file instead.",
      longLines:
        "This file has very long lines, so no diff is shown. View the file instead.",
      tooLarge: "This file is too large to diff here. View the file instead.",
      timeLimit: "The diff took too long. View the file instead.",
      tooManyLines:
        "This diff has more than 5,000 lines, too many to show here. View the file instead.",
    },
  },
  fileTree: {
    filter: "Filter files",
    filterPlaceholder: "Filter files…",
    clearFilter: "Clear filter",
    view: "File view",
    tree: "Tree",
    list: "List",
    noMatches: "No files match “{{query}}”.",
    lineChanges: "{{added}} lines added, {{removed}} removed",
  },
  selectMenu: {
    placeholder: "Select",
  },
  slashMenu: {
    label: "Skills",
    empty:
      "No skills match “{{query}}”. Promote and select one in workspace → Skills.",
  },
};
