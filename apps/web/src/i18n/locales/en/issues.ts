/** The Issues page: board, list, composer, notices and Issue states. */
export const issues = {
  status: {
    pending: "Pending",
    in_progress: "In progress",
    blocked: "Blocked",
    verifying: "Verifying",
    accepted: "Accepted",
    abandoned: "Abandoned",
  },
  blocked: {
    defaultMessage: "Provide the information or decision needed to continue.",
    reason: {
      needs_input: "Needs input",
      needs_permission: "Needs permission",
      system_error: "System error",
    },
    /** The board badge: waiting for a reply is a normal step, not a failure. */
    badge: {
      needs_input: "Needs your reply",
      needs_permission: "Needs permission",
      system_error: "Needs attention",
    },
  },
  readiness: {
    direction: "Needs human direction",
    inferring: "Inferring readiness…",
    proposal: "Needs proposal",
    ready: "Ready to execute",
    split: "Needs split",
    unsuitable: "Not automatable",
    amendmentPending: "Contract amendment pending",
    awaitingContract: "Awaiting contract confirmation",
  },
  phase: {
    preparing: "Preparing execution",
  },
  review: {
    needsAttention: "Needs attention",
    awaitingReview: "Awaiting your review",
    reviewCandidate: "Review candidate",
  },
  /** Drafts the composer starts from when adding to a board column. */
  template: {
    blocked: "Describe the information or decision needed to continue.",
    pending: "Capture this idea and prepare the goal and completion criteria.",
    accepted: "Describe a follow-up after the last accepted workspace change.",
    in_progress: "Create an issue that can start working locally.",
    verifying: "Create an issue with clear verification criteria.",
    abandoned: "Describe a new direction after an abandoned Issue.",
  },
  card: {
    open: "Open {{id}}",
    accepted: "Accepted",
    priority: {
      high: "High",
      medium: "Medium",
      low: "Low",
    },
  },
  board: {
    add: "Add {{status}} issue",
    empty: "No issues",
  },
  list: {
    id: "ID",
    issue: "Issue",
    status: "Status",
    runtime: "Runtime",
    updated: "Updated",
  },
  strip: {
    clean: "{{baseline}} · clean",
    counts: "{{accepted}} accepted · {{resolved}} resolved",
    viewLabel: "Workspace view",
  },
  page: {
    viewLabel: "Issue view",
    board: "Board",
    list: "List",
    inputLabel: "New issue input",
    placeholder: "Describe a task for Claude or Codex in this workspace…",
    agentLabel: "Issue agent",
    submit: "Submit issue",
    opening: "Opening",
    needsAgent: "Configure an agent in Settings to create an Issue",
    hint: "Describe the goal first; you can upload references in the conversation. Execution starts only after you confirm the completion criteria.",
  },
  notices: {
    needsRealAgent: "Configure a real agent in Settings first.",
    stillSaving: "Still saving the current issue.",
    describeFirst: "Describe the issue first.",
    creating: "Creating issue…",
    created: "Issue created · awaiting contract confirmation",
    unreachable:
      "Could not create issue because the local API is not reachable.",
  },
  worker: {
    title: "This device's Worker needs an update",
    body: "It can clarify and verify, but cannot execute confirmed Issues yet; confirmed Issues will keep waiting. Run <code>{{command}}</code> on this device to update it, then they can run. A device set up before that command existed runs <code>{{legacy}}</code> once instead.",
  },
  models: {
    providerDefault: "Provider default",
  },
};
