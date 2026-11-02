// Package sessions is the session lifecycle every workflow depends on: a
// session starts and is handed to its device or waits for it, takes
// messages (steered into a running turn or queued as its next input),
// stops, and exchanges messages with other sessions through its inbox. It
// also carries the typed bus (Events) that tells a session's viewers what
// happened to it and then, in their order, everything on the server that
// reacts to sessions.
//
// It does not know HTTP, MCP or the device wire: httpapi resolves who may
// ask (actors, workspaces, Issues), implements the ports (Devices, Policy,
// Chats) over its device hub and the rest of the server, and keeps the
// handlers. A refusal is a Refusal, which httpapi answers with its status.
//
//	events := sessions.NewEvents(stream)                  // viewers, then observers
//	events.Observe(sessions.Observers{Changes: …, Events: …, Ends: …})
//	svc := sessions.New(st, events, sessions.Ports{…})    // one per server
//	svc.Start(ctx, input)                                 // resolve the device, create, dispatch or wait
//	svc.CreateAndDispatch(ctx, input, reconcile, before)  // a resolved input
//	svc.Send(ctx, sessionID, input, before)               // steer or queue the next input
//	svc.Cancel(ctx, sessionID, orchestrator)              // stop; never cascades
//	svc.SendInboxMessage(ctx, target, …)                  // another session's message, with its receipt
//	svc.PumpInbox(ctx)                                    // place held messages (background, InboxKicks)
//	svc.NoticeUnstarted(ctx); svc.ExpireDeviceWaits(ctx, now) // the stale-session sweep
//
// Dependencies: store, eventstream and browserevent (the messages viewers
// get). It must not import httpapi.
package sessions
