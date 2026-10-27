package httpapi

import (
	"context"
	"errors"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const nativeArchiveCapability = "native_archive_v1"

type wsNativeArchivePayload struct {
	DryRun bool                      `json:"dryRun,omitempty"`
	Items  []store.NativeArchiveItem `json:"items"`
}
type wsNativeArchiveResultPayload struct {
	wsReplyError
	Items []store.NativeArchiveTarget `json:"items"`
}

func (h *DaemonHub) reconcileNativeArchives(deviceID string) {
	c := h.connectionFor(deviceID)
	if c == nil {
		return
	}
	c.nativeArchiveMu.Lock()
	defer c.nativeArchiveMu.Unlock()
	st, ok := h.store.(store.ChatArchiveStore)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.lifetime, 90*time.Second)
	defer cancel()
	defer func() {
		if h.dataChanges != nil {
			h.dataChanges.changed("", fieldChats, fieldAgentSessions)
		}
	}()
	targets, err := st.NativeArchiveTargets(ctx, deviceID)
	if err != nil {
		return
	}
	items := []store.NativeArchiveTarget{}
	for _, t := range targets {
		if t.State == "pending" || t.State == "unsupported" || t.State == "failed" {
			items = append(items, t)
		}
	}
	if len(items) == 0 {
		return
	}
	if !c.hasCapability(nativeArchiveCapability) {
		for _, t := range items {
			t.State = "unsupported"
			t.Error = "Update the worker to archive native conversations"
			_ = st.RecordNativeArchiveResult(ctx, t)
		}
		return
	}
	// One target per call bounds worker execution and makes a partial transport
	// failure retryable without repeating successful items on reconnect.
	for _, t := range items {
		result, e := callDevice[wsNativeArchiveResultPayload](ctx, c, wsNativeArchiveType, wsNativeArchivePayload{Items: []store.NativeArchiveItem{nativeArchiveItem(t)}})
		if e != nil {
			if errors.Is(e, context.Canceled) {
				return
			}
			t.State = "failed"
			t.Error = e.Error()
			_ = st.RecordNativeArchiveResult(ctx, t)
			continue
		}
		for _, v := range result.Items {
			if v.DeviceID != deviceID || v.Provider != t.Provider || v.NativeSessionID != t.NativeSessionID || v.Generation != t.Generation {
				continue
			}
			_ = st.RecordNativeArchiveResult(ctx, v)
		}
	}
}

// Online metadata preflight discloses the exceptional case of a native child
// that is also a separately controlled Foundry session. Offline devices keep
// the generic cascade warning until their native copy can be inspected.
func (s *Server) previewNativeArchives(ctx context.Context, actor Actor, ws string, ids []string) ([]store.ArchiveHiddenChat, error) {
	st, err := s.archiveStore()
	if err != nil {
		return nil, err
	}
	targets, err := st.NativeArchivePreview(ctx, ws, ids)
	if err != nil {
		return nil, err
	}
	hidden := []store.ArchiveHiddenChat{}
	seen := map[string]bool{}
	for _, t := range targets {
		if t.Provider != "codex" {
			continue
		}
		c := s.hub.connectionFor(t.DeviceID)
		if c == nil || !c.hasCapability(nativeArchiveCapability) {
			continue
		}
		requestCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		result, e := callDevice[wsNativeArchiveResultPayload](requestCtx, c, wsNativeArchiveType, wsNativeArchivePayload{Items: []store.NativeArchiveItem{nativeArchiveItem(t)}, DryRun: true})
		cancel()
		if e != nil {
			continue
		}
		for _, v := range result.Items {
			for _, native := range v.NativeDescendantIDs {
				owner, e := s.store.NativeSessionOwner(ctx, "codex", native)
				if e != nil {
					return nil, e
				}
				if owner == "" || seen[owner] {
					continue
				}
				member, e := s.store.GetAgentSessionSummary(ctx, owner)
				if e == nil && s.canReadSession(ctx, actor, member) {
					seen[owner] = true
					hidden = append(hidden, store.ArchiveHiddenChat{ID: owner, Title: member.Title})
				}
			}
		}
	}
	return hidden, nil
}

func nativeArchiveItem(t store.NativeArchiveTarget) store.NativeArchiveItem {
	return store.NativeArchiveItem{Provider: t.Provider, NativeSessionID: t.NativeSessionID, DeviceID: t.DeviceID, SessionID: t.SessionID, ProfileID: t.ProfileID, WorkspacePath: t.WorkspacePath, Desired: t.Desired, Generation: t.Generation}
}
