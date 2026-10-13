package httpapi

import (
	"context"
	"errors"
	"log"
	"slices"
	"sort"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (h *DaemonHub) DispatchReady() {
	h.mu.Lock()
	connections := make([]*daemonConnection, 0, len(h.connections))
	for _, connection := range h.connections {
		connections = append(connections, connection)
	}
	h.mu.Unlock()

	for _, connection := range connections {
		connection.claimAndSend()
	}
}

func (c *daemonConnection) claimAndSend() {
	c.claimMu.Lock()
	defer c.claimMu.Unlock()
	deviceID, registration := c.registrationSnapshot()
	if deviceID == "" || registration.Workspace.ID == "" {
		return
	}
	// An older worker would run an Issue as a plain chat; it gets no Issues.
	if !slices.Contains(registration.Capabilities, store.DaemonCapabilityIssueSessions) {
		return
	}
	c.registrationMu.Lock()
	ids := make([]string, 0, len(c.registrations))
	for id := range c.registrations {
		ids = append(ids, id)
	}
	c.registrationMu.Unlock()
	if len(ids) == 0 {
		ids = append(ids, registration.Workspace.ID)
	}
	sort.Strings(ids)
	capacity := 4
	if registration.Device.RuntimeSettings != nil && registration.Device.RuntimeSettings.MaxConcurrentTasks > 0 {
		capacity = registration.Device.RuntimeSettings.MaxConcurrentTasks
	}
	producing := 0
	for _, id := range ids {
		issues, err := c.hub.store.ListIssues(context.Background(), id)
		if err != nil {
			return
		}
		for _, issue := range issues {
			if issue.Status == "in_progress" {
				producing++
			}
		}
	}
	if producing >= capacity {
		return
	}
	var (
		session store.AgentSession
		err     error
	)
	for offset := 0; offset < len(ids); offset++ {
		index := (c.claimCursor + offset) % len(ids)
		_, session, err = c.hub.store.ClaimIssueExecution(context.Background(), deviceID, ids[index])
		if !errors.Is(err, store.ErrNotFound) {
			c.claimCursor = (index + 1) % len(ids)
			break
		}
	}
	if errors.Is(err, store.ErrNotFound) {
		return
	}
	if err != nil {
		c.reply(wsEnvelope{Type: wsErrorType, Error: err.Error()})
		return
	}
	// The claim started the Issue and queued its session without an event.
	c.hub.dataChanges.changed(session.WorkspaceID, fieldIssues, fieldAgentSessions)
	// A dispatch that does not reach the worker leaves the session queued;
	// the device's next registration sends it again.
	if err := c.dispatchAgentSession(session); err != nil {
		log.Printf("dispatch issue execution %s: %v", session.ID, err)
	}
}
