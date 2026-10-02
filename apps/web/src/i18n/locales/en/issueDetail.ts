/** One Issue: detail view, contract, evidence, verification, environment and transcript. */
export const issueDetail = {
  shared: {
    stepUnfinished: "This step is not finished",
    listSeparator: ", ",
    clauseSeparator: "; ",
    quoted: "“{{text}}”",
    required: "Must meet",
    optional: "Additional goal",
    version: "v{{version}}",
  },
  carriers: {
    separator: " / ",
    text_log: "run log",
    image: "screenshot or image",
    video: "screen recording",
    audio: "audio",
    http_exchange: "actual request and response",
    test_report: "test report",
    data: "data",
    document: "delivered document",
    file: "delivered file",
    other: "actual material",
  },
  method: {
    agent:
      "An independent Agent reads the actual material and makes a preliminary judgment against the criteria below; this is not the implementing Agent saying it is done.",
    checker: "Checked by a fixed program: {{description}}",
    checkerMissing:
      "Planned to be checked by a fixed program; the checker is not ready yet, so it cannot pass for now.",
  },
  evidenceRequirement: "{{description}} (at least {{minimum}}; {{carriers}})",
  phase: {
    accepted: {
      title: "Accepted and integrated",
      next: "The result is in the Workspace; you can review the acceptance record from that time.",
    },
    abandoned: {
      title: "Abandoned",
      next: "The conversation and candidate are kept; it will not run or be integrated.",
    },
    amendment: {
      title: "Criteria change awaiting confirmation",
    },
    clarifying: {
      title: "Clarifying the goal and criteria",
      next: "Answer questions or adjust the request in the main chat; no new implementation starts before you confirm.",
    },
    inProgress: {
      title: "Executing",
      next: "The Agent is working to the confirmed criteria; you can give feedback in the chat.",
    },
    verifying: {
      title: "Awaiting acceptance",
      next: "Review the actual material and judgments; you cannot accept while evidence is missing or a criterion has not passed.",
    },
    question: {
      title: "Waiting for your answer",
      next: "The Agent asked you something in the main chat; answer there and it continues in the same candidate.",
    },
    blocked: {
      title: "A blocker needs attention",
      next: "See the reason in the main conversation, deal with it, then continue.",
    },
    waiting: {
      title: "Waiting to execute",
      next: "The criteria are confirmed; waiting for a device and execution capacity.",
    },
  },
  verdict: {
    stale:
      "Needs a recheck: this result no longer applies to the current version.",
    notEvaluated:
      "Not checked yet: collect material and start verification first.",
    evidenceUnavailable:
      "Evidence unavailable: restore the original material before accepting.",
    freshnessUnknown:
      "Cannot yet confirm whether this result applies to the current version.",
    pass: "Check passed",
    fail: "Does not meet the agreement; needs changes",
    inconclusive: "Cannot judge yet; needs more material or clearer findings",
  },
  verificationError: {
    busy: "Two checks of the same task collided, so there is no result yet. Wait for the current check to finish, then try again.",
    offline:
      "The execution device is offline for now. Check again once it reconnects; existing material and records are kept.",
    timeout:
      "The check did not finish in time. Look at the technical record and confirm the last result before trying again.",
    interrupted:
      "The last check's result is not confirmed yet. The system will try to recover the saved result and will not run it again automatically.",
    generic:
      "The check hit a technical problem and has no reliable result yet. Open the technical record to see why, deal with it, then check again.",
  },
  blocker: {
    contract_unconfirmed:
      "The completion criteria are not confirmed yet. Go back to the main chat and review the draft.",
    contract_amendment_pending:
      "A criteria change is awaiting confirmation. Confirm or withdraw it before continuing.",
    checker_missing:
      "The fixed checker is not ready yet; implementation notes cannot count as a pass.",
    verification_pending:
      "Some criteria have no check result for this version yet.",
    verification_error:
      "A check did not finish normally. See why, then check again.",
    required_failed:
      "A required criterion did not pass; ask for a fix in the main chat.",
    required_inconclusive:
      "A required criterion cannot be judged yet; more evidence is needed.",
    evidence_missing:
      "Not enough actual material; collect the delivered files or other agreed material first.",
    input_unbound:
      "Cannot yet prove the verification environment matches the current candidate, so it cannot be accepted.",
    stale: "The results are out of date; check the current version again.",
    material_unavailable:
      "The original material cannot be read right now; restore the device or material, then check again.",
    candidate_changed:
      "The candidate's content or availability changed; review it and collect verification again.",
    baseline_changed:
      "The Workspace baseline changed; align with it, then verify and approve again.",
  },
  criterion: {
    authority: {
      program: "Fixed program check",
      agent_preliminary: "Independent Agent's preliminary judgment",
      human: "Human judgment",
      none: "No judgment yet",
    },
    fallbackTitle: "Completion criterion",
    queued:
      "Waiting to check: starts automatically after the criteria ahead finish.",
    running: "Checking real material…",
    failed: "The check did not finish; it cannot be accepted on this basis.",
    checking: "Checking material; wait for the actual result…",
    expected: "Expected: ",
    observed: "Observed: ",
    viewEvidence: "View the actual evidence",
    viewReference: "Compare with the reference (not actual evidence)",
    limitations: "Limitations: ",
    reasoning: "Full reasoning",
    noResult:
      "No judgment to review yet; prepare the current version and collect the agreed actual material first.",
    method: "Compare with the confirmed criterion and verification method",
    recheck: "Recheck this criterion",
    opinionCurrent: "Human opinion · current",
    opinionEarlier: "Human opinion · earlier",
    technicalRecord: "Technical record",
  },
  assessment: {
    summary: "Disagree with the preliminary judgment?",
    body: "Explain which actual material leads you to a different judgment; the original judgment is not overwritten. An opinion cannot make up for missing evidence.",
    reasonLabel: "Reason for the human judgment",
    placeholder: "Explain your reason using the actual evidence above…",
    pass: "Meets the criterion",
    fail: "Does not meet it",
    inconclusive: "Still cannot judge",
  },
  verification: {
    titleCollect: "Collect and check",
    titlePrepare: "Prepare actual acceptance material",
    intro:
      "The system reads real files from the fixed candidate, keeps the original material, then checks each criterion. An implementation summary never counts as evidence.",
    entryLabel: "Candidate entry file for service “{{name}}”",
    entryAria: "Entry file for service {{name}}",
    entryPlaceholder:
      "For example handler.mjs (default-exports a Node HTTP handler)",
    align: "Align with the Workspace and prepare a new acceptance round",
    prepare: "Prepare acceptance for the current version",
    alignNote:
      "Aligning creates a new candidate; earlier judgments and approvals cannot be reused.",
    planned: "Will collect: {{items}}.",
    changesList: "system-generated list of candidate changes",
    materialUnavailable: "material unavailable",
    noneFound: "no suitable material found yet; expand to choose",
    adjust: "Adjust evidence material (at least {{minimum}})",
    changesOption:
      "System-generated list of candidate changes (compared with the original baseline, not the Agent's own account)",
    nonFile:
      "This needs material that is not a file. This round cannot collect it automatically, and a document cannot stand in for it; adjust the evidence plan or use material management.",
    programIntro:
      "The system runs the project's own command; the exit code decides pass or fail, and the output is kept as-is as evidence.",
    missing:
      "Cannot collect yet: no evidence material is chosen for {{criteria}}. Expand “Adjust evidence material” to choose files.",
    collect: "Collect selected material and check all criteria",
    collectNote:
      "Material and results are kept. Clicking again starts a new round of checks; earlier passes are not reused.",
    commandInline:
      "Will run: <code>{{command}}</code> (working directory {{cwd}}, no network).",
    commandSummary:
      "View the command to run (working directory {{cwd}}, no network)",
  },
  evidence: {
    intro:
      "See what was actually delivered, the basis for each judgment and what is still missing. The goal and how it is checked stay under “Goal and agreement”.",
    titleAccepted: "Result accepted and integrated",
    titleNotStarted: "Not in acceptance yet",
    titleEligible: "Ready to accept; review the actual evidence",
    titleNotYet: "Cannot accept yet",
    confirmFirst:
      "Clarify and confirm the criteria in the main chat first. Reference material and implementation notes cannot stand in for actual evidence.",
    inProgress:
      "Implementation is still in progress. Once it finishes, prepare a fixed candidate and collect material; it cannot be accepted yet.",
    loading: "Reading the acceptance state and confirmed criteria…",
    noCandidate:
      "No acceptance candidate is prepared yet. Choose “Prepare acceptance for the current version” first, then collect real material.",
    checking: "Checking actual material. This updates automatically when done.",
    refresh: "Refresh results",
    finalTitle: "Final acceptance",
    finalBody:
      "Accept the exact version and review results shown here; the system checks them again, then integrates them into the Workspace. It shows “Accepted” only after everything integrates.",
    accepted: "Accepted and integrated",
    abandoned: "Abandoned · read-only history",
    accept: "Accept this result",
    errorBody:
      "The acceptance gate was not bypassed; deal with the reason and try again.",
    advanced: "Advanced material management and technical record",
  },
  materials: {
    summary: "Actual materials and collection",
    previewSealed: "Preview sealed material",
    requirement: "Evidence requirement",
    requirementOption: "{{criterion}}: {{requirement}}",
    requirementPlaceholder: "Select the exact evidence requirement",
    upload: "Upload actual evidence or reference material",
    attestationLabel: "Material provenance and candidate attestation",
    attestationPlaceholder:
      "Where was this captured, and why does it represent this exact candidate?",
    notAttestable:
      "Material {{id}} saved. This requirement does not permit human-attested evidence.",
    uploadButton: "Upload material",
    uploadAndAttest: "Upload material and attest candidate binding",
    uploadNote:
      "Upload alone creates a Material, not proof. Reference material IDs can be added to the next contract draft’s media fields.",
    repository: "Snapshot repository",
    path: "Candidate file path",
    pathPlaceholder: "Relative file path in the sealed snapshot",
    export: "Export candidate file as evidence",
  },
  preview: {
    lines: "Lines {{start}}–{{end}}",
    sealedAlt: "Sealed evidence",
    download: "Download original material",
    technical: "Material technical details",
    unavailable:
      "Preview unavailable for this format or size; download the original.",
    reference: "{{role}}: {{caption}}",
    role: {
      target: "Target reference",
      example: "Example",
      counterexample: "Counterexample",
      context: "Background",
    },
  },
  question: {
    inputTitle: "The Agent needs your decision",
    permissionTitle: "The Agent asks for your permission",
    approve: "Approve",
    deny: "Deny",
    answerHint:
      "Choose an answer, or write your own in the chat below. The Agent continues in the same candidate.",
    finishingTurn:
      "The Agent is finishing its turn; you can answer in a moment.",
  },
  alignment: {
    title: "Aligning hit a merge conflict",
    body: "The Workspace's newer accepted changes and this candidate both changed the same lines in:",
    resolve: "Ask the Agent to resolve it",
    after:
      "The Agent resolves the conflict in the candidate, keeping both the accepted changes and this Issue's goal; then you check and accept again.",
  },
  exitRules: {
    label: "Exit rules",
    version: "Every rule must hold before you can accept ({{version}}).",
    notYet: "not yet",
    rules: {
      R1: "The exact criteria are confirmed",
      R2: "The reviewed candidate is the finished, current one",
      R3: "Every required criterion has been checked",
      R4: "Every required criterion passed",
      R5: "All required evidence exists and can be read",
      R6: "Every check is for these criteria and this candidate",
    },
  },
  sessions: {
    title: "Sessions in this Issue",
    intro:
      "Every Agent session that worked on this Issue, and who started it. Open one to read its full transcript.",
    none: "No session has worked on this Issue yet.",
    execution: "Execution",
    clarification: "Clarification",
    helper: "Helper session",
    startedBy: "Started by the {{role}}",
    open: "Open the {{role}} transcript",
  },
  view: {
    notFoundTitle: "Issue not found",
    notFoundBody: "Return to Issues to select a task.",
    organizing: "Organizing the criteria…",
    reviewDraft: "Review the completion criteria",
    organizingNext:
      "The Agent is working; no implementation starts in this phase.",
    gotoEvidence: "View acceptance results",
    gotoEnvironment: "Check the execution environment",
    gotoChat: "Back to the main chat",
    tabs: {
      details: "Goal and agreement",
      evidence: "Acceptance results",
      changes: "Changes",
      environment: "Environment",
    },
    closeDetails: "Close issue details",
    environmentIntro:
      "See where it runs, its candidate repositories and any environment blockers; you usually don't need to do anything here.",
    location: "Where it runs",
    device: "Device",
    baseline: "Workspace baseline",
    noChangesTitle: "No changes to review yet",
    noChangesBody:
      "After the criteria are confirmed and the implementation is done, the candidate's actual file differences appear here. No sample changes are made up before implementation starts.",
    requestChanges: "Request changes",
    createFollowUp: "Create follow-up",
    followUpDraft: "Follow up on {{id}}: {{title}}\n\n{{source}}",
    guide: "Guide this Issue",
    continue: "Continue conversation",
    abandonBlocked: "Stop execution before abandoning",
    abandonHint: "Keep history and the candidate without integrating",
    abandoning: "Abandoning…",
    abandon: "Abandon issue",
    back: "Back to Issues",
    hideDetails: "Hide issue details",
    showDetails: "Show issue details",
    detailsLabel: "Issue details",
  },
  contract: {
    goal: "Task goal",
    confirmed: "Confirmed",
    draft: "Draft awaiting confirmation",
    revision: "Revision {{revision}}",
    goalMissing: "The result you want still needs to be made clear.",
    criteria: "Completion criteria",
    noCriteria:
      "No observable completion criteria yet. Tell the Agent in the chat what problem you want solved.",
    howVerified: "How it is verified and judged",
    howVerify: "How it is verified: ",
    basis: "Basis for judgment: ",
    scope: "Scope and limits",
    inScope: "Included this time",
    outOfScope: "Not doing this time",
    constraints: "Must respect",
    references: "References and background",
    referencesNote: "These guide the direction; they do not prove the result.",
  },
  contractPanel: {
    intro:
      "This keeps the goal and how it is checked, as we agreed. To change them, go back to the main chat.",
    untitled: "Goal not organized yet",
    legacyNote:
      "Earlier text does not become confirmed criteria automatically.",
    continueTitle: "Keep discussing",
    amendTitle: "Need to change the agreement?",
    draftBody:
      "The confirmation card in the main chat and this panel show the same draft. A plain “continue” does not start implementation.",
    amendBody:
      "Execution feedback does not rewrite the criteria. Proposing a change pauses new execution and acceptance until you confirm again.",
    beginAmendment: "Propose a criteria change",
    discard: "Withdraw the change and keep the confirmed criteria",
    sourceInput: "Original input",
    technical: "Technical details and revision history",
    technicalNote:
      "Internal identities are for audit only; no need to edit them.",
    revisionLine: "Revision {{revision}} · {{status}} · {{reason}}",
    originalGoal: "Original goal",
    errorTitle: "The action did not finish",
  },
  confirmation: {
    title: "Review this version of the completion criteria",
    body: "Below is revision {{revision}} exactly as saved. Implementation starts only after you confirm; to change it, just reply in the chat below.",
    basis: "What this draft is based on",
    confirm: "Confirm criteria and start",
  },
  contractErrors: {
    busy: "The previous action is still in progress; please wait.",
    savedNotRefreshed:
      "Saved, but the page could not refresh. It updates automatically once the connection is back; don't submit again.",
    amendFirst:
      "Propose a criteria change first, then discuss the new completion criteria.",
    unsupportedReference:
      "References can be text, JSON, PNG, JPEG or GIF this round; other formats cannot be given to the clarifying Agent yet.",
    referenceTooLarge:
      "Reference too large: images up to 25 MiB, text up to 512 KiB.",
    nothingToDiscard: "There is no draft to withdraw.",
  },
  environment: {
    title: "Execution environment",
    loadFailed: "Could not load environment",
    candidateStatus: "Candidate status",
    candidateSize: "Candidate size",
    notMeasured: "Not measured",
    size_one: "{{size}} MiB · {{count}} file",
    size_other: "{{size}} MiB · {{count}} files",
    counts:
      "{{registered}} registered · {{prepared}} prepared · {{unavailable}} unavailable",
    availabilityNote:
      "Source availability describes registered repositories. Only prepared candidates belong to this Issue’s execution environment.",
    needsAttention: "Environment needs attention",
    untracked: "Files outside the accepted baseline ({{total}})",
    untrackedNote:
      "Commit these files into the source baseline or add intended ignore rules before Accept.",
    preview: "Preview: {{state}}",
    openPreview: "Open preview",
    stop: "Stop execution",
    startPreview: "Start preview",
    stopPreview: "Stop preview",
    cleanup: "Clean accepted worktrees",
    loading: "Loading environment…",
  },
  environmentStatus: {
    not_prepared: "Not prepared",
    unprepared: "Not prepared",
    ready: "Ready",
    preparing: "Preparing",
    running: "Running",
    review: "Awaiting review",
    failed: "Preparation failed",
    integrated: "Integrated",
    cleaned: "Cleaned",
    unavailable: "Unavailable",
    unborn: "Needs initial commit",
    conflict: "Boundary conflict",
    unknown: "Unknown",
  },
  repositories: {
    label: "Repository inventory",
    title: "Repositories",
    search: "Search repositories",
    searchPlaceholder: "Search repository paths…",
    filter: "Repository filter",
    all: "All registered repositories",
    unavailable: "Unavailable / needs attention",
    prepared: "Prepared candidates",
    range: "{{from}}–{{to}} of {{total}}",
    none: "No matching repositories",
    sourceAvailability: "Source availability",
    candidate: "Issue candidate",
    type: "Repository type",
    previous: "Previous repositories",
    next: "Next repositories",
  },
  candidate: {
    changed: "Candidate changed. Refresh the Issue before accepting.",
    title: "Workspace candidate · revision {{revision}}",
    loading: "Loading candidate changes…",
    noChanges: "No file changes.",
    truncated:
      "Diff truncated. Review the remaining changes in the candidate directory before accepting.",
  },
  conversation: {
    clarifyFirst:
      "Start clarifying under “Goal and agreement” first; execution begins after the criteria are confirmed.",
    noExecution: "No active Issue execution",
    organizing: "Organizing the goal and completion criteria…",
    welcome:
      "First we'll agree on the goal and completion criteria; I'll start changing things only after you confirm.",
    retryClarify: "Retry goal clarification",
    keptNote:
      "Your input and saved content are kept; send again after dealing with the reason.",
    replyFailedTitle: "The Agent could not reply",
    noReply: "The Agent ended without a reply.",
    retryReply: "Ask again",
    replyKeptNote:
      "Your message is kept. Ask again, or send a new message instead.",
    inputLabel: "Issue follow-up",
    sendLabel: "Send issue message",
    placeholderClarifying:
      "Describe the result you want, answer follow-up questions, or upload references…",
    placeholderWorking: "Guide the agent while it works…",
    placeholderAnswer: "Answer the Agent's question…",
    placeholderContinue: "Continue this Issue in its candidate workspace…",
    readOnlyAccepted: "Accepted into Workspace.",
    readOnlyAbandoned:
      "Abandoned. Candidate and conversation history are retained.",
    readOnlyFollowUp: "Create a follow-up Issue for further changes.",
  },
  transcript: {
    failureTitle: "Execution interrupted",
    failure:
      "The candidate files are kept. Reply below to retry in the same candidate, or open “Environment” to check first.\n\nReason: {{reason}}",
    working: "Working in candidate workspace…",
  },
  actions: {
    newIssue: "New issue",
    reviewEvidence: "Review evidence and acceptance",
    requestChanges: "Request changes",
    startProduction: "Start production",
    retryInCandidate: "Retry in candidate",
    guide: "Guide this Issue",
    createFollowUp: "Create follow-up",
    issues: "Issues",
    openAssets: "Open assets",
    unblock: "Unblock issue",
    unblockDraft: "Unblock {{id}}: {{title}}\n\n{{checks}}",
  },
  inspector: {
    status: "Status",
    checks: "Checks",
    skillPacksUsed: "Skill packs used",
    runtime: "Runtime",
    device: "Device",
    started: "Started",
    contextPriority: "Context priority",
    workspaceContext: "Workspace context",
    authoritative: "authoritative",
    skillPacks: "Skill packs",
    reusable: "reusable",
    workerRuntime: "Worker runtime",
    executionOnly: "execution only",
    artifactPending: "Artifact appears here when ready",
    stop: "Stop execution",
    readiness: "Readiness",
  },
  sections: {
    runtimeSkills: "Worker runtime & skills",
    runtimeCaption: "runtime · stateless",
    with: "with",
    workersNote:
      "Workers do not remember. Everything for this run comes from the workspace context and the loaded skill packs.",
    runEvents: "Run events",
    live: "live",
    noEventsTitle: "No run events",
    noEventsBody: "Run events appear after a local worker starts.",
    acceptanceCriteria: "Acceptance criteria",
  },
  surface: {
    back: "Issues",
    primaryArtifact: "Primary artifact:",
    run: "run",
    user: "User",
  },
  compare: {
    title: "Artifact · baseline compare",
    baseline: "Baseline",
    candidate: "Candidate",
    new: "New",
    files: "Files",
    changedFiles: "Changed files",
  },
};
