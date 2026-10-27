/**
 * The assistant (Personal Agent): its home page and its settings. Written
 * for people who do not know how Foundry works: "project" and "computer",
 * never workspace, device or session.
 */
export const personalAgent = {
  maintenance: {
    title: "Context and memory maintenance",
    description:
      "Changed content is combined into short read-only reviews. Unchanged sources do not call a model. At most one maintenance run at a time and four new runs per day; failed runs can be retried twice.",
    boundaries:
      "The configured role reads its data on that project’s computer. Suggestions do not change facts or files. File changes need your review and wait for active conversations to finish. A pending device receipt keeps new work out of that project. Independent services and other programs keep their existing permissions.",
    error: "Maintenance could not be updated",
    refresh: "Refresh",
    empty: "No content changes are waiting for review.",
    memory: "Memory",
    governance: "Workspace context",
    openRun: "Open review conversation",
    retry: "Retry review",
    dismiss: "Dismiss",
    preview: "Review file change",
    current: "Current source",
    proposed: "Proposed source",
    missing: "This file does not exist yet.",
    stale: "The source changed. This proposal cannot be applied.",
    apply: "Apply this reviewed change",
    states: {
      pending: "Waiting to start",
      waiting: "Waiting",
      starting: "Starting",
      running: "Reviewing",
      review: "Needs your review",
      complete: "Healthy",
      failed: "Review failed",
      dismissed: "Dismissed",
      superseded: "Combined into a newer change",
      applying: "Waiting for file receipt",
      applied: "Applied",
      conflict: "Source changed",
    },
    reasons: {
      input_moved:
        "This conversation moved to another input. The old review will not read or stop that newer turn.",
      assistant_paused: "The assistant is paused.",
      maintenance_busy: "Another maintenance review is active.",
      daily_maintenance_limit:
        "Today’s maintenance budget is used; this change remains saved.",
      role_configuration_unavailable:
        "Choose an available account and location for this role.",
      role_configuration_changed:
        "The pinned account or workspace access changed.",
      device_offline: "The source computer is offline.",
      worker_update_required:
        "Update the source computer’s worker to run this role safely.",
      source_unavailable:
        "The source is unavailable or its authority is moving.",
      sandbox_unavailable: "The computer cannot provide the read-only sandbox.",
      account_unavailable:
        "The selected account is unavailable on the source computer.",
      input_acceptance_failed:
        "The saved review could not be accepted; it will be reconciled.",
      invalid_review_result:
        "The model did not return a valid bounded proposal.",
      native_failed:
        "The native review failed. Inspect its conversation before retrying.",
      native_canceled: "The review was stopped.",
      waiting_for_device_receipt:
        "Waiting for the computer to confirm the exact file operation.",
      source_changed_review_again:
        "The source changed before applying. Review a new proposal.",
      permission_changed:
        "Workspace ownership changed. No further write is authorized.",
      source_location_changed:
        "The workspace moved. Its original operation needs reconciliation.",
      receipt_mismatch:
        "The device receipt did not match the approved operation.",
    },
  },
  planning: {
    executionStillOpen:
      "This work may still be running. Marking it complete does not stop it.",
    details: "Details and evidence",
    completed: "Completed",
    resultAvailable: "Result available",

    cancelPending: "Cancel unsent step",
    reasons: {
      worker_update_required:
        "The loaded worker needs an update; this request stays saved.",
      existing_owner_busy:
        "The existing owner is still working. This follow-up stays saved.",
      owner_configuration_differs:
        "The owner uses different execution settings. Review the account or explicitly choose a clean continuation.",
      execution_configuration_unavailable:
        "The configured execution account or location is unavailable.",
      device_offline:
        "The target computer is offline; the request stays saved.",
      assistant_paused: "The assistant is paused.",
      dependency_pending: "A prerequisite is not complete yet.",
      existing_owner_conflict:
        "More than one owner is linked. Clarify which one should continue.",
      owner_permission_required:
        "Control of the existing owner is unavailable.",
      dispatch_unavailable:
        "The request could not be delivered. Inspect the saved receipt before retrying.",
      workspace_writer_busy:
        "Another conversation is writing in this project. Wait or reuse its owner.",
      execution_completed_requires_evidence:
        "The execution ended; its output still needs verification.",
      execution_failed:
        "The execution failed. Its conversation contains the failure evidence.",
      execution_cancelled: "The execution was cancelled.",
      intent_changed: "The saved intent changed before this step could run.",
      owner_input_changed_requires_evidence:
        "The owner has moved to another input. Verify the earlier result in its history.",
      execution_policy_limit:
        "Execution is waiting for your policy or usage limit.",
    },
    record: "Record only",
    execute: "Execution authorized",
    next: "Next: {{action}}",
    waitingFor: "Waiting for: {{reason}}",
    location: "Project: {{workspace}}",
    dependencyDone: "Dependency complete: {{task}}",
    dependencyPending: "Waiting on: {{task}}",
    owner: "Open current owner",
    reference: "Open linked conversation",
    issue: "Open linked issue",
    service: "Independent service: {{id}}",
    dispatchState: "Dispatch: {{state}}",
    unknownHint:
      "The input may already have been accepted. Reconcile its existing conversation before sending anything again.",
    recoverHint:
      "Ask the assistant to inspect the saved item and current owner before continuing; this preserves the task identity.",
    inspectRun: "Inspect execution",
    evidence: "Completion evidence",
    inspectEvidence: "Open evidence",
    evidenceNeeded:
      "Execution ended. Review its output and evidence before marking the item complete.",
    saveFailed: "Could not save this plan",
    mode: "What should happen",
    modeHint:
      "Saving a plan does not send work by itself. The assistant checks the request, dependencies and existing owner before dispatching.",
    workspace: "Project",
    unassigned: "Choose later",
    nextLabel: "Next useful action",
    waitingLabel: "What is missing or blocking it",
    dependencies: "Wait for these items",
    save: "Save plan",
    cancel: "Cancel",
    edit: "Plan and links",
    continueLabel: "Ask assistant to continue",
    continuePrompt:
      "Please inspect saved item {{id}} ({{text}}), its dependencies, previous dispatch receipts and existing owner, then help me with its next authorized step. Reuse this item; do not duplicate it. If it is record-only, help plan it and ask before executing. If an outcome is unknown, reconcile it first.",
    continueFailed: "Could not save the continuation request",
    route: "Routing: {{reason}}",
    clarify: "A clarification is needed before execution.",
    personSelected: "The person selected this project in the plan.",
    completeHint:
      "The checkbox records your completion decision. Active executions have their own stop control.",
    progress: {
      inbox: "Needs a next step",
      ready: "Ready",
      waiting: "Waiting",
      working: "In progress",
      review: "Review result",
    },
    operation: {
      pending: "Saved",
      waiting: "Waiting",
      dispatching: "Sending",
      delivered: "Accepted by execution",
      unknown: "Outcome unknown",
      review: "Result to review",
      failed: "Failed",
      cancelled: "Cancelled",
    },
  },
  runs: {
    waitReasons: {
      device_offline: "Waiting for the original computer to reconnect.",
      worker_update_required:
        "The loaded execution host needs an update before it can stop an exact input safely.",
      native_end_pending:
        "Cancellation was requested; waiting for the native input to end.",
    },
    title: "Role runs and stop receipts",
    boundaries:
      "Stop targets the recorded input, not a later conversation turn. Stopping the assistant pauses new dispatch and requests stops of its executions; independent workspace services keep their own lifecycle.",
    budgetHint:
      "Time limits run on the device. Token limits use observed main-runtime input and output, including cached input. Reporting and in-flight requests may overshoot; unreported or child usage is not an exact billing cap.",
    failed: "Could not update run controls",
    refresh: "Refresh runs",
    monitoring: "Monitoring execution",
    stopRequested: "Awaiting stop receipt",
    stopped: "Stop confirmed",
    inputMoved: "Original input replaced; newer input untouched",
    settled: "Execution ended",
    configuration:
      "Pinned: {{account}} · requested {{model}} / {{effort}} · {{workspace}} on {{device}}",
    requestedOnly:
      "These are requested settings. Actual model or effort is known only when the native runtime reports it in the conversation.",
    defaultValue: "Account default",
    usage:
      "Observed {{tokens}} / {{budget}} tokens · {{state}} · {{minutes}} minute limit",
    reason: "Reason: {{reason}}",
    open: "Open execution",
    stopInput: "Stop this input",
    empty: "No role executions recorded yet.",
  },
  knowledge: {
    forgetPending: "Forget pending memory",
    forgetPendingConfirm:
      "Forget this identity, including any write already in flight?",

    authorizationReview:
      "Review authorization: the source, audience or account configuration changed",
    cachedAccount:
      "Cached account: {{label}}. This is not online identity verification.",
    accountNotNamed: "the native profile has not named its account",

    states: {
      pending: "Waiting to initialize",
      waiting: "Waiting",
      active: "Authority ready",
      migrating: "Moving authority",
      frozen: "Source writes frozen",
      activating: "Activating destination",
      freezing: "Freezing source",
      copying: "Copying verified revisions",
      verifying: "Verifying copy",
      retiring: "Disabling the old writer",
      complete: "Complete",
      cancelled: "Cancelled",
      aborting: "Cancelling before authority switch",
      writing: "Waiting for file receipt",
      applied: "Applied",
      superseded: "Replaced by a newer change",
      forgotten: "Owner source cleared",
      forgetting: "Recall revoked; erasing copies",
      missing: "Owner file missing",
      revoked: "Revoked",
    },
    reasons: {
      memory_device_offline: "The source computer is offline.",
      memory_worker_update_required:
        "Update the worker on the source computer.",
      knowledge_owner_required: "You need ownership of the source workspace.",
      memory_workspace_must_be_private:
        "The main memory workspace must be private.",
      memory_device_must_be_owned:
        "Choose a computer you own for the main memory.",
      not_empty: "This folder is not empty. Choose a new empty folder.",
      fenced:
        "This source has a different authority version. Check its migration.",
      unsafe_path: "Choose a real folder inside the workspace, without links.",
      locked: "A source write is active or needs recovery.",
      revision_conflict:
        "The source changed. Read and review its current revision.",
      external_edit:
        "The source was edited outside its saved revision. Review file edits before adopting.",
      forgotten: "This identity has been revoked.",
      idempotency_conflict:
        "This request identity already describes different content. Refresh before retrying.",
      knowledge_location_unavailable: "The source location is unavailable.",
      knowledge_authority_not_ready: "The authority is initializing or moving.",
      authority_initialization_changed:
        "Saved work is waiting for the new initial location.",
    },
    retryInitial: "Use a different initial location",
    retryInitialHint:
      "This source has not acknowledged any fact writes. Choose another empty location; saved undelivered writes will follow it. Existing files in the previous folder are not imported or deleted. An established source must use migration instead.",
    retryInitialFolder: "Different empty source folder",
    offlineSource:
      "The source computer is offline or unavailable. Its index may still be visible; reading and writing wait for that computer.",
    forgetScope:
      "Forgetting clears the owner fact and registered copies, and revokes future recall. Conversation history, domain outputs and ordinary files have separate retention. Accepted file writes, forgetting and migrations are managed here; pausing the assistant does not undo them.",
    expired: "Expired; not used as current knowledge",

    repairIndex: "Rebuild index from owner files",
    repairConfirm:
      "Confirm source review and rebuild metadata; keep all revocations",

    transfer: "Move reviewed fact to Memory Workspace",
    transferConfirm: "Confirm this fact and move its authority",
    legacyMoving:
      "Transfer saved. The legacy text is frozen until the owner file confirms it; then this copy is erased. You can still forget it, including the pending copy.",

    reviewSource: "Review file edits",
    adoptTitle: "Review a changed source",
    adoptHint:
      "This text came from the file, outside the saved revision. Verify and correct it before adopting it. The file hash must still match; this will create a new confirmed revision under your review.",
    adopt: "Adopt reviewed source",
    capacity:
      "Each root supports 1,000 identities including revocation records. Capacity errors never hide older entries. Forgetting also prevents learning new facts from the same old input; a fresh confirmation can be saved.",

    legacyIntro:
      "Existing server-held facts keep their original owner until you explicitly transfer them. New facts belong in the selected Memory Workspace above; no existing content is moved automatically.",
    isolationHint:
      "Folder privacy follows the device’s operating-system account. Recall grants control Foundry’s knowledge interface; they do not isolate other processes running as that account.",
    moveTitle: "Move the knowledge authority",
    moveHint:
      "Choose an empty folder in an existing owner workspace. The source freezes during copying; the pointer switches only after verification. Cancellation is available before the switch. Retained old copies remain read-only and receive future forgetting requests.",
    moveDevice: "Destination device",
    moveWorkspace: "Destination workspace",
    movePath: "Empty destination folder",
    move: "Start verified migration",
    moveProgress: "{{state}} · {{copied}} / {{total}} records · {{reason}}",
    moveRoute: "{{from}} → {{to}}",
    cancelMove: "Cancel before switching",
    cancelWaiting: "Restoring the old authority…",
    copyCleanup: "Retained copy erasure: {{state}} {{reason}}",

    recallTitle: "Main-memory recall",
    recallHint:
      "Allow the assistant’s selected account to recall confirmed current facts from this main root. Domain sources still require individual references. Account or audience changes do not inherit this permission.",
    previewRecall: "Preview assistant account",
    recallAccount: "Account: {{profile}} · {{provider}} · {{device}}",
    enableRecall: "Allow this account to recall main memory",

    domainTitle: "Domain knowledge source",
    domainHint:
      "Keep confirmed facts with the project that owns them. Its existing members can see its files. This does not copy resumes, documents or task state into your main memory.",
    domainWorkspace: "Owner workspace",
    addDomain: "Use this domain source",

    title: "Knowledge and memory location",
    intro:
      "Keep facts in their owner workspace. Share specific versions through references; documents and live task state stay in their original project.",
    device: "Memory storage device",
    independent:
      "This can differ from the device that runs your assistant. Private content is not silently moved when it is offline.",
    workspace: "Private memory workspace",
    private:
      "Existing workspaces must be owned by you and have no other members. A new location starts as a private knowledge folder.",
    newWorkspace: "Create a dedicated private workspace",
    folder: "Folder inside the workspace",
    useLocation: "Set memory location",
    connected: "Connected",
    offline: "Offline; existing locations can wait",
    failed: "Knowledge action could not finish",
    location: "{{workspace}} on {{device}} · {{path}}",
    state: "Location: {{state}} {{reason}}",
    migrationHint:
      "Changing location requires an explicit migration that freezes the old source before switching ownership.",
    source: "Knowledge owner",
    forgotten: "Forgotten entry",
    entryState:
      "Revision {{revision}} · {{state}} · {{source}} · expiry: {{expiry}}",
    noExpiry: "Not set",
    inspect: "Read / correct / share",
    forget: "Forget",
    forgetConfirm: "Revoke retrieval now and erase the owner text?",
    entryTitle: "Short title",
    body: "Source text",
    expiry: "Valid until (optional)",
    expiryHint:
      "Use an ISO timestamp, for example 2027-01-01T00:00:00Z. Expired facts remain reviewable but are not recalled for action.",
    correct: "Save correction to owner",
    add: "Add knowledge",
    newEntry: "New entry",
    publishTitle: "Publish a versioned reference",
    publishHint:
      "Only the selected account in this workspace can recall this version. Consider who can see the target workspace and its conversations. Changed sources or audiences require renewed publication.",
    target: "Target workspace",
    account: "Allowed execution account",
    purpose: "Purpose of reuse",
    publish: "Publish this version",
    published: "{{purpose}} → {{workspace}} · {{profile}} · {{state}}",
    revoke: "Revoke reference",
    pending: "{{title}}: {{state}} {{reason}}",
    forgetLimits:
      "Forgetting blocks new retrieval immediately. Device cleanup waits if offline. Previously exported copies, conversation history and backups are not erased by this action.",
  },

  defaultName: "Assistant",
  loading: "Loading…",
  unavailable: {
    title: "The assistant isn't available here yet",
    body: "This Foundry server doesn't offer the assistant yet. Ask whoever runs it to update.",
  },
  loadFailed: "Couldn't load your assistant",
  retry: "Try again",
  inbox: {
    workerUpdateRequired:
      "The loaded worker needs an update; this request stays saved.",
    savedWaiting: "Saved requests waiting to run",
    retrySettingsHint:
      "After changing the account or execution settings, you can retry an unaccepted request. Its original identity and receipt time are kept; an in-flight input cannot be replayed here.",
    retryWithSettings: "Retry with current settings",
    failedTitle: "Saved requests that need attention",
    retrySaved: "Retry this saved request",
    openResult: "Open the previous attempt",
    readFailed: "Couldn't refresh received requests",
    received: "{{count}} message(s) saved. You don't need to send them again.",
    pending: "Received · waiting to process",
    deviceOffline: "Saved · waiting for the computer",
    accountUnavailable: "Saved · check the assistant's account in Settings",
    paused: "Saved · processing is paused",
  },
  home: {
    intro:
      "Tell me what you want done. I'll work out where it belongs, keep an eye on it and tell you how it went.",
    openSettings: "Settings",
    stopAll: "Stop assistant work",
    stopping: "Stopping…",
    resume: "Resume",
    resuming: "Resuming…",
    stopped: {
      title: "New work paused",
      body: "Nothing new starts until you resume. Check Activity for execution stop receipts; independent services are managed separately.",
    },
    offline: {
      title: "{{device}} is offline",
      body: "Messages are still saved here. Your assistant will process them when its computer is back. You can request stops now; confirmation waits for the computer.",
      action: "Move to another computer",
    },
  },
  conversation: {
    label: "Conversation with your assistant",
    placeholder: "Ask anything, or say what you want done…",
    inputLabel: "Message to your assistant",
    send: "Send",
    stopReply: "Stop this reply",
    working: "Working on it…",
    waitingForComputer: "Waiting for {{computer}} to come online",
    waitingForComputerDetail:
      "I'll pick this up by myself once {{computer}} is back online.",
    newConversation: "New conversation",
    emptyTitle: "What can I do for you?",
    emptyBody:
      "For example: “Make a small web page to track our family spending” or “Remind me tomorrow at 9 to pay the rent”.",
    loadFailed: "Couldn't load the conversation",
    offline: "Your assistant's computer is offline.",
    stopped: "Assistant processing is paused. Say “resume” to carry on.",
    noRuntime:
      "Your assistant can't think yet: {{device}} has no AI sign-in it can use. Set one up on that computer.",
  },
  commands: {
    accepted: "You said yes: {{summary}}",
    declined: "You said no: {{summary}}",
  },
  proposal: {
    kicker: "Needs your OK",
    accept: "OK",
    decline: "No thanks",
    expires: "Expires {{when}}",
    answerFailed: "Couldn't send your answer",
    status: {
      pending: "Waiting for you",
      accepted: "You said yes",
      declined: "You said no",
      expired: "Expired — nothing was changed",
      applied: "Done",
      failed: "Couldn't be done",
    },
  },
  list: {
    title: "Your list",
    open: "To do",
    doneToday: "Done today",
    empty: "Tell me what you plan to do and I'll keep it here.",
    reminder: "Reminder {{time}}",
    helping: "I'm helping",
    actionsFor: "Actions for “{{text}}”",
    edit: "Edit",
    delete: "Delete",
    deleteTitle: "Delete from your list?",
    deleteBody: "Delete “{{text}}” from your list? This can't be undone.",
    deleteAction: "Delete",
    textLabel: "What",
    whenLabel: "When",
    whenPlaceholder: "e.g. after work",
    save: "Save",
    saving: "Saving…",
    cancel: "Cancel",
    loadFailed: "Couldn't load your list",
    failed: "Couldn't change your list",
  },
  tasks: {
    title: "What I'm doing",
    empty: "Nothing in progress right now.",
    ended: "Finished in the last day",
    where: "In “{{project}}”",
    started: "Started {{when}}",
    stuck: "May be stuck",
    open: "See progress",
    stop: "Stop",
    stopping: "Stopping…",
    stopFailed: "Couldn't stop it",
    loadFailed: "Couldn't load what I'm doing",
    waitingForComputer: "Waiting for {{computer}} to come online",
    status: {
      queued: "Waiting its turn",
      running: "In progress",
      asking: "Has a question for you",
      done: "Done",
      failed: "Didn't work out",
      cancelled: "Stopped",
    },
  },
  setup: {
    title: "Give your assistant a home",
    body: "It keeps its notes in one folder on one of your computers. Nothing else on that computer changes.",
    computer: "Computer",
    action: "Set up on {{device}}",
    working: "Setting up…",
    offline: "{{device}} is offline right now. Pick a computer that's on.",
    shared:
      "This computer's system account is shared with {{names}}, so they would reach your assistant's files and sign-ins there.",
    chooseComputer: "Choose a computer",
    actionUnchosen: "Set up",
    onlyShared:
      "Each of your computers shares its system account with someone else, so none is picked for you. Choose one if you're fine with them reaching your assistant's files and sign-ins there.",
    failed: "Couldn't set up your assistant",
    noComputer: {
      title: "Connect a computer first",
      body: "Your assistant does its work on your own computer. Connect one, then come back here.",
      action: "Connect a computer",
    },
  },
  settings: {
    devices: {
      removedSourceHint:
        "The computer for this source was removed. Its saved location and records remain, but its files cannot be read or changed here. No files have been moved or deleted.",
      removed: "Removed",
      unavailable: "Computer no longer available",
      removedHint:
        "These saved references belong to removed computers. Work and project creation are disabled. Choose a new location explicitly; files and previous locations have been kept.",
    },
    title: "Assistant settings",
    sectionsLabel: "Settings sections",
    sections: {
      status: "Status",
      style: "Name & style",
      memory: "About me",
      rules: "When to ask me",
      places: "Where it works",
      models: "Model",
      entry: "Entry & notifications",
      limits: "Usage & limits",
      activity: "Activity",
    },
    save: "Save changes",
    saving: "Saving…",
    saved: "Settings saved.",
    discard: "Discard",
    unsaved: "You have unsaved changes.",
    saveFailed: "Couldn't save the settings",
    loosen: {
      title: "This lets your assistant do more without asking",
      body: "It will no longer ask before: {{actions}}.",
      confirm: "Yes, save",
    },
    problems: {
      extraInstructions: "Extra requests can be at most 2,000 characters.",
      dailyDigestTime: "Write the summary time as HH:MM, for example 09:00.",
      activeHours: "Write the hours as HH:MM, for example 09:00 and 22:00.",
      limit: "“{{label}}” must be between {{min}} and {{max}}.",
      limitNoMax: "“{{label}}” must be a whole number from {{min}} up.",
    },
    status: {
      state: "Status",
      running: "Running",
      stoppedSince: "Stopped {{when}}",
      home: "Lives on",
      online: "Online",
      offline: "Offline",
      move: "Move it to",
      moveAction: "Move",
      moving: "Moving…",
      moveHint:
        "It sets up a new home there. Its notes come along when both computers are on.",
      moveOffline:
        "{{device}} is offline. It can move only to a computer that's on.",
      moved: "Your assistant now lives on {{device}}.",
      moveFailed: "Couldn't move your assistant",
      moveUnavailable: "This Foundry server can't move the assistant yet.",
      noOther: "You have no other computer to move it to.",
    },
    style: {
      name: "Its name",
      language: "Language it speaks",
      languages: {
        account: "Same as my account",
        en: "English",
        zhCN: "中文",
      },
      timezone: "Time zone",
      timezonePlaceholder: "This browser's: {{zone}}",
      timezoneHint: "For reminders and the daily summary, e.g. Asia/Shanghai.",
      speakingStyle: "How it talks",
      speaking: {
        auto: "Follow me",
        plain: "Plain words",
        technical: "Technical",
      },
      verbosity: "How much detail",
      verbosities: {
        concise: "Short",
        detailed: "Detailed",
      },
      extra: "Anything else it should know about how you like things done",
      extraHint:
        "Added to its instructions. It can't change the safety rules below.",
      extraCount: "{{count}} / 2,000",
    },
    memory: {
      intro:
        "What your assistant knows about you. Only you can see this, and forgetting erases it.",
      addLabel: "Something it should remember",
      addPlaceholder: "For example: I prefer short answers",
      add: "Remember",
      adding: "Saving…",
      empty: "Nothing yet. It learns as you talk, or add something here.",
      pendingTitle: "Waiting for your OK",
      pendingBody:
        "These come from things it read, not from you. They don't count until you confirm them.",
      origin: {
        stated: "You told it",
        edited: "You wrote it",
        inferred: "Its guess",
        external: "From something it read",
      },
      added: "Added {{when}}",
      confirm: "Confirm",
      edit: "Edit",
      editLabel: "Edit what it remembers",
      save: "Save",
      cancel: "Cancel",
      forget: "Forget",
      forgetConfirm: "Forget for good?",
      forgetAll: "Forget everything",
      forgetAllConfirm: "Really forget everything?",
      export: "Export",
      failed: "Couldn't change what it remembers",
      loadFailed: "Couldn't load what it remembers",
    },
    rules: {
      intro:
        "Your assistant sets up and tidies projects for you. Choose what it does on its own and what it asks you about first.",
      presets: "Presets",
      preset: {
        cautious: "Ask me more",
        default: "Recommended",
        hands_off: "Hands off",
      },
      custom: "Your own choices",
      decision: {
        auto: "Just do it",
        ask: "Ask me first",
        deny: "Don't",
      },
      actions: {
        create_workspace: "Start a new project in its folder on your computer",
        register_folder: "Use a folder you already have as a project",
        rename_workspace: "Rename a project or change what it's for",
        add_skill: "Give a project a new skill",
        remove_skill_created: "Remove a skill from a project it started",
        remove_skill: "Remove a skill from any other project",
        bind_connector:
          "Let a project act as you (for example in Feishu), the first time",
        unbind_connector: "Take that access away again",
        archive_workspace: "Put a project away (everything in it is kept)",
        archive_session: "Archive or restore chats",
        restore_workspace: "Bring a put-away project back",
      },
      archiveSessionHint:
        "Up to 3 chats follow this setting. Folders and more than 3 chats always ask for confirmation, unless archiving is denied.",
      neverTitle: "Never, whatever you choose",
      neverBody:
        "Deleting projects or files, sharing with other people, changing your computers' settings, or approving finished work for you. It gives you a link to do these yourself.",
    },
    places: {
      intro: "Which of your computers it may use.",
      work: "Can work on this computer",
      create: "Can start new projects here",
      folder: "New projects go in {{folders}}",
      noFolder: "This computer hasn't said where new projects go yet.",
      openComputer: "Computer settings",
      preferred: "Default place",
      preferredHint:
        "Self-contained work starts here. Work that needs something only another computer has, like the company network or your work files, goes to a computer that has it; note what each has on its settings page. If none does, your assistant asks you.",
      preferredHome: "Where it lives ({{device}})",
      has: "Noted: {{notes}}",
      hasNothing: "Nothing noted about this computer yet.",
      shared:
        "Shares its system account with {{names}}: they can reach what your assistant does here. New projects go here only if you allow it below or make it the default place.",
      none: "You haven't connected a computer of your own yet.",
    },
    models: {
      catalogFailed: "Could not refresh account choices",
      refreshCatalog: "Refresh account choices",
      deviceOffline: "Computer offline",

      defaultRuntime: "Agent on target computer",
      runtimeDefault: "Follow its default",
      checkedOnTarget: "{{name}} (checked on target)",
      catalogPreview:
        "Model names from {{account}} on {{device}}. Each target checks its own support.",

      rolesIntro:
        "Choose one default, then override only the roles that need a different account or model. Files keep their location; the selected account processes the context needed by its role.",
      defaultTitle: "Shared default",
      roles: {
        coordinator: "Conversation and routing",
        memory: "Memory maintenance",
        governance: "Project maintenance",
        executor: "Work execution",
      },
      override: "Use separate settings for this role",
      inherits:
        "Inherits the shared default. Execution follows the target workspace's device.",
      enabled: "Enable this role",
      location: "Execution device",
      locationHint:
        "Must match the target workspace's device. Changing this choice does not move the workspace.",
      targetLocation: "Follow target workspace",
      tokenBudget: "Token budget per run",
      timeout: "Maximum run time (minutes)",
      fallbackHint:
        "No automatic account change unless a fallback below explicitly allows this workspace.",
      fallbackWorkspace: "Fallback {{index}}: allowed workspace",
      fallback: "Fallback {{index}}",
      chooseWorkspace: "Choose a workspace",
      chooseAccount: "Choose an explicit account",
      removeFallback: "Remove fallback",
      addFallback: "Add an explicit fallback",
      available: "Reported available",
      unavailable: "Currently unavailable",
      missingChoice: "{{name}} (not currently listed)",
      accountHint:
        "Accounts belong to their device; model services must be assigned to it. A local sign-in alone does not prove online availability.",
      effort: "Reasoning effort",
      effortHint:
        "The requested level must be supported by the runtime and model. Actual reported settings are recorded separately.",
      applyNext:
        "Saved changes apply to new runs. Existing runs keep their recorded configuration; unavailable choices wait rather than silently switching.",
      intro:
        "What your assistant thinks with. The choices come from the device it lives on.",
      service: "What it runs on",
      serviceDefault: "Its device's default",
      model: "Model",
      modelDefault: "The default for that choice",
      loading: "Loading…",
      none: "No choices found on {{device}}.",
      delegate: "Work it hands off uses",
      delegates: {
        same_as_assistant: "The same as the assistant",
        device_default: "Each device's default",
      },
    },
    entry: {
      homePage: "Open the assistant when I open Foundry",
      interface: "Interface",
      interfaces: {
        full: "Full",
        simple: "Simple",
      },
      interfaceHint:
        "Simple shows only your assistant and its settings. It applies wherever you sign in.",
      feishuTitle: "Feishu",
      feishuDirectChat: "Answer my direct messages in Feishu",
      feishuApp: "Feishu app",
      feishuAppDefault: "My app in Connectors",
      feishuHint: "Apps and pairing are set up in Connectors.",
      openConnectors: "Open Connectors",
      digestTitle: "Daily summary",
      dailyDigest: "Send me a daily summary",
      dailyDigestTime: "At",
      hoursTitle: "Quiet hours",
      activeHoursStart: "Updates from",
      activeHoursEnd: "until",
      hoursHint: "Updates outside these hours wait until they start.",
      urgentAnytime: "Things that need my decision can come any time",
    },
    limits: {
      intro:
        "Safety limits. When your assistant reaches one, it stops and tells you.",
      labels: {
        concurrentSessions: "Things running at once",
        dailySessions: "Things started per day",
        dailyWorkspaces: "New projects per day",
        weeklyWorkspaces: "New projects per week",
        hourlyTurns: "Replies per hour",
        dailyDigestSessions: "Project summaries per day",
        stuckAfterMinutes: "Say a job may be stuck after (minutes)",
        monthlyTokenBudget: "Monthly usage budget (tokens, 0 = none)",
      },
      now: "Now: {{value}}",
      max: "At most {{max}}",
      usageNote:
        "Usage counts what your computers report; anything they don't report isn't counted.",
    },
    activity: {
      intro:
        "Everything it changed or tried to change in the last 90 days, newest first.",
      empty: "Nothing yet.",
      loadFailed: "Couldn't load the activity",
      outcome: {
        auto: "Done on its own",
        confirmed: "Done with your OK",
        proposed: "Asked you",
        refused: "Not done",
        failed: "Failed",
      },
      refusal: {
        not_allowed: "not allowed",
        not_owner: "not your project",
        limit: "a limit was reached",
        stopped: "it was stopped",
        invalid: "the request didn't make sense",
        no_place: "none of your computers had what it needed",
      },
      tools: {
        create_workspace: "Start a project",
        update_workspace: "Change a project",
        archive_workspace: "Put a project away",
        remember: "Remember something",
        update_rules: "Change when to ask you",
        register_folder: "Use an existing folder",
        rename_workspace: "Rename a project",
        add_skill: "Add a skill",
        remove_skill_created: "Remove a skill",
        remove_skill: "Remove a skill",
        bind_connector: "Give a project your access",
        unbind_connector: "Take access away",
        archive_session: "Archive or restore chats",
        restore_workspace: "Bring a project back",
        relax_rules: "Ask you less",
      },
    },
  },
};
