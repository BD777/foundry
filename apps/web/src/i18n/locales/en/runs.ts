/** The Runs page and run phase/status wording. */
export const runs = {
  phase: {
    executing: "Executing",
    complete: "Complete",
    failed: "Failed",
    queued: "Queued",
    canceled: "Canceled",
  },
  status: {
    blocked: "Blocked",
    canceled: "Canceled",
    completed: "Succeeded",
    failed: "Failed",
    queued: "Queued",
    running: "Running",
  },
  duration: {
    minutes: "{{minutes}}m {{seconds}}s",
    seconds: "{{seconds}}s",
  },
  filter: {
    label: "Run status filter",
    all: "All",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
  },
  empty: {
    title: "No runs",
    body: "Runs appear after a local worker claims an issue.",
  },
  table: {
    label: "Runs table",
    mobileLabel: "Runs list",
    run: "Run",
    issue: "Issue",
    runtime: "Runtime",
    phase: "Phase",
    duration: "Duration",
    status: "Status",
  },
};
