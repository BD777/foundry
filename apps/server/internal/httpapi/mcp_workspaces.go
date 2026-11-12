package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Where and how an agent can start sessions, as the Foundry tools show it:
// the workspaces it reaches, each device's resources and the workspaces on
// it, and a device's profiles and their models.

func (s *Server) listWorkspacesForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	view, err := s.visibilityFor(ctx, call.actor)
	if err != nil {
		return "", err
	}
	all, err := s.store.ListWorkspaces(ctx)
	if err != nil {
		return "", err
	}
	// A device removed a moment ago is no longer listed; its workspaces go
	// with it.
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return "", err
	}
	listed := map[string]bool{}
	for _, device := range devices {
		listed[device.ID] = true
	}
	type reachable struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		DeviceID    string `json:"deviceId,omitempty"`
		DeviceLabel string `json:"deviceLabel,omitempty"`
		AccessRole  string `json:"accessRole"`
		// Unavailable explains why sessions cannot run in it now.
		Unavailable string `json:"unavailable,omitempty"`
	}
	workspaces := []reachable{}
	for _, workspace := range view.scope.filterWorkspaces(all) {
		if workspace.DeviceID != "" && !listed[workspace.DeviceID] {
			continue
		}
		item := reachable{workspace.ID, workspace.Name, workspace.DeviceID, workspace.DeviceLabel, workspace.AccessRole, ""}
		if workspace.UnavailableOnDevice != nil {
			item.Unavailable = workspaceNotServedMessage(workspace)
		}
		workspaces = append(workspaces, item)
	}
	return encodeJSON(workspaces)
}

// mcpResourceInstance is one inventory instance as list_resources shows it.
type mcpResourceInstance struct {
	ID          string                   `json:"id"`
	Type        string                   `json:"type"`
	Platform    string                   `json:"platform"`
	Name        string                   `json:"name"`
	State       string                   `json:"state"`
	StateReason string                   `json:"stateReason,omitempty"`
	Stale       bool                     `json:"stale,omitempty"`
	Readiness   *store.ResourceReadiness `json:"readiness,omitempty"`
	Backends    []string                 `json:"backends,omitempty"`
	Details     map[string]string        `json:"details,omitempty"`
	LastSeenAt  string                   `json:"lastSeenAt,omitempty"`
	// Holder and Queue: who leases it and how many sessions wait for it.
	Holder *store.ResourceHolder `json:"holder,omitempty"`
	Queue  int                   `json:"queue,omitempty"`
	// Operations: what operate_resource runs on it once leased.
	Operations []string `json:"operations,omitempty"`
}

// listResourcesForMCP is the Resource Pool directory as an agent sees it:
// every device it can reach, what each offers, whether it is online, and the
// workspaces on it where the agent may start a session: its inventory of
// instances with type, platform and readiness (type narrows it).
func (s *Server) listResourcesForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	resourceType, deviceID := mcpArgString(call.args, "type"), mcpArgString(call.args, "deviceId")
	// Without detailed, each instance is what picking one needs: what it is,
	// its state, why it is not ready and who holds it.
	detailed := mcpArgBool(call.args, "detailed")
	view, err := s.visibilityFor(ctx, call.actor)
	if err != nil {
		return "", err
	}
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return "", err
	}
	all, err := s.store.ListWorkspaces(ctx)
	if err != nil {
		return "", err
	}
	type workspaceOnDevice struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		AccessRole string `json:"accessRole,omitempty"`
	}
	type deviceResources struct {
		DeviceID    string                `json:"deviceId"`
		DeviceLabel string                `json:"deviceLabel"`
		Online      bool                  `json:"online"`
		Connection  string                `json:"connection"`
		Workspaces  []workspaceOnDevice   `json:"workspaces"`
		Instances   []mcpResourceInstance `json:"instances"`
	}
	instances := map[string][]mcpResourceInstance{}
	list, err := s.resources.List(ctx, store.ResourceFilter{SourceID: deviceID, Type: resourceType})
	if err != nil {
		return "", err
	}
	for _, instance := range list.Instances {
		holder, operations := mcpResourceHolder(instance)
		backends := []string{}
		for _, backend := range instance.Backends {
			backends = append(backends, strings.TrimSuffix(backend.ID+"@"+backend.Version, "@"))
		}
		entry := mcpResourceInstance{
			ID: instance.ID, Type: instance.Type, Platform: instance.Platform, Name: instance.Name,
			State: instance.State, StateReason: instance.StateReason, Stale: instance.Stale,
			Holder: holder, Queue: instance.Queue,
		}
		if readiness := instance.Readiness; detailed || !readiness.Ready {
			entry.Readiness = &readiness
		}
		if detailed {
			entry.Backends, entry.Details, entry.LastSeenAt, entry.Operations = backends, instance.Details, instance.LastSeenAt, operations
		}
		instances[instance.Source.ID] = append(instances[instance.Source.ID], entry)
	}
	reachable := view.scope.filterWorkspaces(all)
	result := []deviceResources{}
	for _, device := range view.filterDevices(devices) {
		if deviceID != "" && device.ID != deviceID {
			continue
		}
		connection := s.hub.deviceConnection(device.ID)
		entry := deviceResources{
			DeviceID: device.ID, DeviceLabel: device.Label,
			Online: connection.State == resources.ConnectionOnline, Connection: connection.State,
			Workspaces: []workspaceOnDevice{},
			Instances:  append([]mcpResourceInstance{}, instances[device.ID]...),
		}
		for _, workspace := range reachable {
			if workspace.DeviceID == device.ID {
				role := workspace.AccessRole
				if !detailed && role == store.WorkspaceRoleMember {
					role = ""
				}
				entry.Workspaces = append(entry.Workspaces, workspaceOnDevice{workspace.ID, workspace.Name, role})
			}
		}
		result = append(result, entry)
	}
	return encodeJSON(result)
}

// mcpDeviceID is the device a profile tool reads: the named one, else the
// caller's own (a session token's device, or the calling device).
func mcpDeviceID(actor Actor, args map[string]json.RawMessage) string {
	if deviceID := mcpArgString(args, "deviceId"); deviceID != "" {
		return deviceID
	}
	if actor.Agent() {
		return actor.Identity.DeviceID
	}
	return actor.DeviceID
}

func (s *Server) listProfilesForMCP(call mcpCall) (string, error) {
	profiles, err := s.deviceAgentProfiles(call.r.Context(), call.actor, mcpDeviceID(call.actor, call.args))
	if err != nil {
		return "", err
	}
	if runtime := mcpArgString(call.args, "runtime"); runtime != "" {
		filtered := profiles[:0]
		for _, profile := range profiles {
			if profile.Runtime == runtime {
				filtered = append(filtered, profile)
			}
		}
		profiles = filtered
	}
	return encodeJSON(profiles)
}

func (s *Server) listModelsForMCP(call mcpCall) (string, error) {
	profiles, err := s.deviceAgentProfiles(call.r.Context(), call.actor, mcpDeviceID(call.actor, call.args))
	if err != nil {
		return "", err
	}
	profileID := mcpArgString(call.args, "profileId")
	for _, profile := range profiles {
		if profile.ID != profileID {
			continue
		}
		models, err := s.listAgentModels(call.r.Context(), call.actor, agentProfileInputFromProjection(profile))
		if err != nil {
			return "", err
		}
		return pageAgentModelsForMCP(profile, models, call.args)
	}
	return "", &statusError{http.StatusNotFound, errors.New("unknown profile: " + profileID)}
}

type mcpModelItem struct {
	ID            string `json:"id"`
	Label         string `json:"label,omitempty"`
	ContextWindow int64  `json:"contextWindow,omitempty"`
}

type mcpModelPage struct {
	Runtime    string         `json:"runtime"`
	ProfileID  string         `json:"profileId"`
	Models     []mcpModelItem `json:"models"`
	Total      int            `json:"total"`
	NextOffset *int           `json:"nextOffset,omitempty"`
	Hint       string         `json:"hint,omitempty"`
}

const (
	defaultMCPModelLimit = 30
	maxMCPModelLimit     = 100
)

func pageAgentModelsForMCP(profile store.AgentProfileProjection, models []store.AgentModelOption, args map[string]json.RawMessage) (string, error) {
	query := strings.ToLower(strings.TrimSpace(mcpArgString(args, "query")))
	offset := mcpArgNumber(args, "offset", 0)
	limit := mcpArgNumber(args, "limit", defaultMCPModelLimit)
	if offset < 0 {
		return "", invalid("offset must be zero or greater")
	}
	if limit == 0 {
		limit = defaultMCPModelLimit
	}
	if limit < 0 {
		return "", invalid("limit must be greater than zero")
	}
	limit = min(limit, maxMCPModelLimit)

	filtered := make([]mcpModelItem, 0, len(models))
	for _, model := range models {
		if !chatModelForRuntime(profile.Runtime, model) {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(model.ID+"\n"+model.Label), query) {
			continue
		}
		window := model.ContextWindow
		if configured := profile.ContextWindows[model.ID]; configured > 0 {
			window = configured
		}
		filtered = append(filtered, mcpModelItem{ID: model.ID, Label: model.Label, ContextWindow: window})
	}
	total := len(filtered)
	if offset > total {
		offset = total
	}
	end := min(offset+limit, total)
	page := append([]mcpModelItem(nil), filtered[offset:end]...)
	answer := mcpModelPage{Runtime: profile.Runtime, ProfileID: profile.ID, Models: page, Total: total}
	if end < total {
		next := end
		answer.NextOffset = &next
		answer.Hint = fmt.Sprintf("%d more chat-capable models; pass nextOffset (or offset) and a limit up to %d, or narrow with query.", total-end, maxMCPModelLimit)
	}
	return encodeJSON(answer)
}

// chatModelForRuntime drops modalities an agent runtime cannot call as a
// conversation model. Claude Code only invokes Claude models. Codex can use
// OpenAI-compatible chat models from other families, so its filter is by
// modality rather than by vendor.
func chatModelForRuntime(runtime string, model store.AgentModelOption) bool {
	haystack := strings.ToLower(model.ID + "\n" + model.Label)
	if runtime == "claude" && !strings.Contains(haystack, "claude") {
		return false
	}
	for _, marker := range []string{
		"embed", "rerank", "moderation",
		"image", "imagen", "dall-e", "stable-diffusion", "sdxl", "flux",
		"video", "veo", "sora", "kling", "runway",
		"audio", "speech", "tts", "whisper", "transcribe", "voice", "music", "suno",
		"3d", "tripo", "meshy", "point-e", "shap-e",
	} {
		if strings.Contains(haystack, marker) {
			return false
		}
	}
	return true
}
