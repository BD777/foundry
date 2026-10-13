package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

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
	// A removed device's workspaces are gone, as list_resources shows.
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return "", err
	}
	removed := map[string]bool{}
	for _, device := range devices {
		removed[device.ID] = device.Status == "removed"
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
		if removed[workspace.DeviceID] {
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
	ID          string                  `json:"id"`
	Type        string                  `json:"type"`
	Platform    string                  `json:"platform"`
	Name        string                  `json:"name"`
	State       string                  `json:"state"`
	StateReason string                  `json:"stateReason,omitempty"`
	Stale       bool                    `json:"stale,omitempty"`
	Readiness   store.ResourceReadiness `json:"readiness"`
	Backends    []string                `json:"backends,omitempty"`
	Details     map[string]string       `json:"details,omitempty"`
	LastSeenAt  string                  `json:"lastSeenAt"`
	// Holder and Queue: who leases it and how many sessions wait for it.
	Holder *store.ResourceHolder `json:"holder,omitempty"`
	Queue  int                   `json:"queue,omitempty"`
	// Operations: what operate_resource runs on it once leased.
	Operations []string `json:"operations,omitempty"`
}

// listResourcesForMCP is the Resource Pool directory as an agent sees it:
// every device it can reach, what each offers, whether it is online, and the
// workspaces on it where the agent may start a session. resources is what
// the device listed at registration (kind narrows it); instances is its
// inventory with type, platform and readiness (type narrows it).
func (s *Server) listResourcesForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	kind, resourceType, deviceID := mcpArgString(call.args, "kind"), mcpArgString(call.args, "type"), mcpArgString(call.args, "deviceId")
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
		AccessRole string `json:"accessRole"`
	}
	type deviceResources struct {
		DeviceID    string                 `json:"deviceId"`
		DeviceLabel string                 `json:"deviceLabel"`
		Online      bool                   `json:"online"`
		Workspaces  []workspaceOnDevice    `json:"workspaces"`
		Resources   []store.DeviceResource `json:"resources"`
		Instances   []mcpResourceInstance  `json:"instances"`
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
		instances[instance.Source.ID] = append(instances[instance.Source.ID], mcpResourceInstance{
			ID: instance.ID, Type: instance.Type, Platform: instance.Platform, Name: instance.Name,
			State: instance.State, StateReason: instance.StateReason, Stale: instance.Stale,
			Readiness: instance.Readiness, Backends: backends, Details: instance.Details, LastSeenAt: instance.LastSeenAt,
			Holder: holder, Queue: instance.Queue, Operations: operations,
		})
	}
	reachable := view.scope.filterWorkspaces(all)
	result := []deviceResources{}
	for _, device := range view.filterDevices(devices) {
		if device.Status == "removed" || (deviceID != "" && device.ID != deviceID) {
			continue
		}
		entry := deviceResources{
			DeviceID: device.ID, DeviceLabel: device.Label, Online: s.hub.HasConnection(device.ID),
			Workspaces: []workspaceOnDevice{}, Resources: []store.DeviceResource{},
			Instances: append([]mcpResourceInstance{}, instances[device.ID]...),
		}
		for _, workspace := range reachable {
			if workspace.DeviceID == device.ID {
				entry.Workspaces = append(entry.Workspaces, workspaceOnDevice{workspace.ID, workspace.Name, workspace.AccessRole})
			}
		}
		for _, resource := range device.Resources {
			if (kind == "" || resource.Kind == kind) && (resourceType == "" || resource.Kind == resourceType) {
				entry.Resources = append(entry.Resources, resource)
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
	profiles, err := s.store.ListAgentProfiles(call.r.Context(), mcpDeviceID(call.actor, call.args))
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
	profiles, err := s.store.ListAgentProfiles(call.r.Context(), mcpDeviceID(call.actor, call.args))
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
		return encodeJSON(models)
	}
	return "", &statusError{http.StatusNotFound, errors.New("unknown profile: " + profileID)}
}
