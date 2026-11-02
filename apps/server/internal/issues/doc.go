// Package issues is an Issue's lifecycle as every entry reaches it: REST,
// the Feishu desk and session tokens. Each mutation locks the Issue by its
// canonical id, lets the store decide, then tells Events (viewers, then
// observers) and, when the Issue may run, Devices.ClaimReady. It does not
// know HTTP, MCP or the device wire: httpapi checks who may ask (its route
// rules, DecisionRole), implements the ports over its device hub and keeps
// the handlers. A refusal is a sessions.Refusal, which httpapi answers with
// its status.
//
//	events := issues.NewEvents(stream)           // viewers, then observers
//	events.Observe(…)                            // Feishu threads, pending items, digests
//	svc := issues.New(st, events, devices)       // one per server
//	svc.Create(ctx, by, input, options)          // Git, the Issue, its first clarification
//	svc.Message(ctx, by, issueID, text, key)     // a person's message, wherever it is due
//	svc.Confirm / Continue / Abandon / …         // one decision each
//	svc.Observer(); svc.Settle(…)                // its sessions starting and ending
//	svc.Get / List / Summary                     // what the Foundry tools read
//
// Dependencies: store, eventstream and browserevent (the messages viewers
// get), sessions (its refusals and session observers). It must not import
// httpapi.
package issues
