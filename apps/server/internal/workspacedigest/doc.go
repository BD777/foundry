// Package workspacedigest is what the Personal Agent knows of a person's
// projects and devices (docs/personal-agent.md §3): a deterministic digest
// per person × readable workspace, computed from what devices reported and
// the server keeps, and a summary a read-only Foundry session writes on top
// of it. It does not know HTTP, devices or providers: httpapi gathers the
// sources (Sources) and runs the summary sessions; the rows are kept
// through store.WorkspaceDigestStore.
//
// The API the assistant's tools and the run's files use; every call first
// brings the person's digests up to date with their sources, so a rename or
// a lost membership shows at once:
//
//	svc := workspacedigest.New(st, sources)       // cheap; build per call
//	svc.Digest(ctx, userID, workspaceID)          // store.WorkspaceDigest; store.ErrNotFound when unreadable
//	svc.Index(ctx, userID)                        // the L0 project and device index (≤ 3k tokens)
//	svc.Devices(ctx, userID)                      // []store.DeviceDigest of the devices the person owns
//
// The assistant's runtime reads one summary file per project from
// .foundry/projects/<name>.md (ProjectFiles), written from the same
// digests and summaries as the index; the index points at the files. The
// assistant's own routing notes (cards/<workspaceId>.md) live on its home
// device and are named in the project file.
//
// The summary loop: Refresh (observers) and the calls above mark a digest
// dirty when what a summary reads changed and set when it is due (30 min
// after the last change, at most every 6 h); Due lists those, the caller
// claims one (Claim), dispatches a session with source "digest" whose
// prompt is SummaryPrompt, and hands its answer to Complete, which keeps
// the previous summary unless ParseSummary accepts it.
//
// Dependencies: store and personalagent's defaults. The personalagent
// package itself must not import this package; the assistant's flows
// (personalagent/assistant) build the run's files with it, and read
// digests through the port httpapi implements over this service.
package workspacedigest
