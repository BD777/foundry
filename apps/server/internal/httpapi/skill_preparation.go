package httpapi

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const skillPreparationCapability = "skill_content_cache_v1"

type wsPrepareSkillsPayload struct {
	Refs []store.SessionSkillRef `json:"refs"`
}

func skillPreparationChanged(resources []string) bool {
	for _, field := range resources {
		switch field {
		case fieldWorkspaces, fieldWorkspaceSkillBindings, fieldDefaultSkillIDs, fieldWorkspaceBundleIDs,
			fieldDefaultBundleIDs, fieldOffSkillIDs, fieldPromotedSkills, fieldSkillBundles:
			return true
		}
	}
	return false
}

// Coalesce changes and recompute current selections, never prewarm the whole
// library. Offline devices catch up on hello. This is disposable preparation,
// not a session, an authorization grant or a durable background job.
func (h *DaemonHub) queueSkillPreparation() {
	if h == nil || h.isShuttingDown() {
		return
	}
	h.mu.Lock()
	capable := false
	for _, c := range h.connections {
		if c.hasCapability(skillPreparationCapability) {
			capable = true
			break
		}
	}
	h.mu.Unlock()
	if !capable {
		return
	}
	h.skillWarmMu.Lock()
	h.skillWarmDirty = true
	if h.skillWarmRunning {
		h.skillWarmMu.Unlock()
		return
	}
	h.skillWarmRunning = true
	h.skillWarmMu.Unlock()
	go func() {
		for {
			time.Sleep(250 * time.Millisecond)
			h.skillWarmMu.Lock()
			h.skillWarmDirty = false
			h.skillWarmMu.Unlock()
			if !h.isShuttingDown() {
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				if err := h.prepareSelectedSkills(ctx); err != nil && !h.isShuttingDown() {
					log.Printf("Skill prewarm selection: %v", err)
				}
				cancel()
			}
			h.skillWarmMu.Lock()
			if !h.skillWarmDirty || h.isShuttingDown() {
				h.skillWarmRunning = false
				h.skillWarmMu.Unlock()
				return
			}
			h.skillWarmMu.Unlock()
		}
	}()
}

func (h *DaemonHub) prepareSelectedSkills(ctx context.Context) error {
	workspaces, err := h.store.ListWorkspaces(ctx)
	if err != nil {
		return err
	}
	byDevice := map[string][]store.SessionSkillRef{}
	h.mu.Lock()
	for device, c := range h.connections {
		if c.hasCapability(skillPreparationCapability) {
			byDevice[device] = []store.SessionSkillRef{}
		}
	}
	h.mu.Unlock()
	seen := map[string]map[string]bool{}
	for _, workspace := range workspaces {
		if workspace.ArchivedAt != "" || workspace.UnavailableOnDevice != nil {
			continue
		}
		c := h.connectionFor(workspace.DeviceID)
		if c == nil || !c.hasCapability(skillPreparationCapability) {
			continue
		}
		refs, _, err := workspaceSkillRefs(ctx, h.store, workspace.ID)
		if err != nil {
			return err
		}
		// Both runtime-specific built-ins are small, verified immutable versions.
		refs = append(withBuiltinSkills(refs, "claude"), withBuiltinSkills(nil, "codex")...)
		if seen[workspace.DeviceID] == nil {
			seen[workspace.DeviceID] = map[string]bool{}
		}
		for _, ref := range refs {
			key := ref.Checksum + ":" + ref.SourceDigest
			if !seen[workspace.DeviceID][key] {
				seen[workspace.DeviceID][key] = true
				byDevice[workspace.DeviceID] = append(byDevice[workspace.DeviceID], ref)
			}
		}
	}
	for device, refs := range byDevice {
		c := h.connectionFor(device)
		if c == nil || !c.hasCapability(skillPreparationCapability) {
			continue
		}
		payload, err := json.Marshal(wsPrepareSkillsPayload{Refs: refs})
		if err != nil {
			return err
		}
		c.queue(wsEnvelope{Type: wsPrepareSkillsType, Payload: payload})
	}
	return nil
}
