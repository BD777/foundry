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
