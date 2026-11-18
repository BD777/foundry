package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// foundry_settings (DEV-298 S4) reads and changes the person's Foundry setup
// that no other tool covers: the execution default, worker groups, workspace
// agent defaults, and device names and labels. The person's own sessions and
// the sessions they start may call it (mcpToolAllowed); Issue, verifier and
// assistant sessions may not.
//
// Each field has a class. An immediate field changes at once, is audited in
// pa_actions under the person's default assistant, and undo reverts it while
// nothing else has changed it. A person field decides which model, account or
// device runs the person's work; agents never change it, and the person does
// it in Settings. One field per call, so a call never mixes the two.
//
// op pair_code (area feishu) issues a Feishu pairing code for a workspace's bot.
// It is class issued: audited in pa_actions like the others, with no undo, since
// the code binds only the chat that sends it and expires after 10 minutes.

// foundryClass is how a field may change.
type foundryClass string

const (
	foundryImmediate foundryClass = "immediate"
	foundryPerson    foundryClass = "person"
	foundryIssued    foundryClass = "issued"
)

// foundryField is one settable field: its class and, for a person field, what
// the person decides with it (named in the refusal).
type foundryField struct {
	class foundryClass
	why   string
}

// foundryAreas are the areas and their fields. A field not listed is refused.
var foundryAreas = map[string]map[string]foundryField{
	"execution":          personFields("which model, account and device run the person's work by default; no Foundry tool sets it yet", "providerKind", "providerId", "runtime", "model", "workerGroupId", "effort", "alternatives"),
	"workspace_defaults": personFields("which account and model new sessions in a workspace start with; no Foundry tool sets it yet", "scope", "routeId", "profileId", "runtime", "model", "effort"),
	"worker_groups": {
		"label": {class: foundryImmediate},
		// worker_groups (save) changes members, so update points there.
		"members": {class: foundryPerson, why: "which models, accounts and devices a worker group runs on"},
	},
	"devices": {
		"name":   {class: foundryImmediate},
		"labels": {class: foundryImmediate},
	},
}

func personFields(why string, names ...string) map[string]foundryField {
	fields := make(map[string]foundryField, len(names))
	for _, name := range names {
		fields[name] = foundryField{class: foundryPerson, why: why}
	}
	return fields
}

// foundrySettingsMCPTools are the tools only the person's own sessions may call.
var foundrySettingsMCPTools = map[string]bool{"foundry_settings": true}

// foundryChange is one immediate change as pa_actions keeps it: enough to undo
// it (Before) and to see that nothing changed it since (After).
type foundryChange struct {
	Op     string          `json:"op"`
	Area   string          `json:"area"`
	ID     string          `json:"id,omitempty"`
	Field  string          `json:"field"`
	Class  foundryClass    `json:"class"`
	Before json.RawMessage `json:"before"`
	After  json.RawMessage `json:"after"`
	Undoes string          `json:"undoes,omitempty"`
}

func (s *Server) foundrySettingsForMCP(call mcpCall) (string, error) {
	switch op := mcpArgString(call.args, "op"); op {
	case "undo":
		return s.foundrySettingsUndo(call)
	case "pair_code":
		return s.foundrySettingsPairCode(call)
	case "get", "update":
		area := mcpArgString(call.args, "area")
		if _, ok := foundryAreas[area]; !ok {
			return "", invalid("area is execution, workspace_defaults, worker_groups or devices, not %q", area)
		}
		if op == "get" {
			return s.foundrySettingsGet(call, area)
		}
		return s.foundrySettingsUpdate(call, area)
	default:
		return "", invalid("op is get, update, undo or pair_code, not %q", op)
	}
}

// foundrySettingsGet answers one area: the execution default (global, or the
// workspace's when workspaceId is set), the workspace's agent defaults, the
// person's worker groups, or their devices with labels.
func (s *Server) foundrySettingsGet(call mcpCall, area string) (string, error) {
	ctx := call.r.Context()
	m, err := s.providerManagerFor(ctx, call.actor)
	if err != nil {
		return "", err
	}
	scope, err := s.scopeOfContext(ctx)
	if err != nil {
		return "", err
	}
	id := mcpArgString(call.args, "id")
	switch area {
	case "execution":
		workspaceID := mcpArgString(call.args, "workspaceId")
		if workspaceID != "" {
			if err := workspaceRefusal(scope, workspaceID, store.WorkspaceRoleViewer); err != nil {
				return "", err
			}
		}
		view, err := s.executionDefaults(ctx, m.userID, workspaceID, nil)
		if err != nil {
			return "", err
		}
		return encodeJSON(view)
	case "workspace_defaults":
		workspace, err := s.settingsWorkspace(ctx, scope, mcpArgString(call.args, "workspaceId"), store.WorkspaceRoleViewer)
		if err != nil {
			return "", err
		}
		answer, err := s.agentDefaultsAnswer(ctx, workspace, m.userID)
		if err != nil {
			return "", err
		}
		return encodeJSON(answer)
	case "worker_groups":
		groups, err := s.store.ListWorkerGroups(ctx, m.userID)
		if err != nil {
			return "", err
		}
		result := []store.WorkerGroup{}
		for _, group := range groups {
			if id != "" && group.ID != id {
				continue
			}
			view, err := s.workerGroupView(ctx, group)
			if err != nil {
				return "", err
			}
			result = append(result, view)
		}
		if id != "" && len(result) == 0 {
			return "", &statusError{http.StatusNotFound, store.ErrWorkerGroupNotFound}
		}
		return encodeJSON(map[string]any{"groups": result})
	default:
		devices, err := s.ownedDevices(ctx, m.userID, id)
		if err != nil {
			return "", err
		}
		placements, err := s.devicePlacements(ctx, devices, time.Now())
		if err != nil {
			return "", err
		}
		answer := []map[string]any{}
		for _, device := range devices {
			answer = append(answer, map[string]any{"id": device.ID, "name": device.Label, "status": device.Status, "labels": placements[device.ID].Labels})
		}
		return encodeJSON(map[string]any{"devices": answer})
	}
}

// foundrySettingsUpdate changes one field. A person field is refused; an
// immediate one is applied, audited and answered with its action id for undo.
func (s *Server) foundrySettingsUpdate(call mcpCall, area string) (string, error) {
	ctx := call.r.Context()
	name, value, err := foundryPatch(call.args)
	if err != nil {
		return "", err
	}
	field, ok := foundryAreas[area][name]
	if !ok {
		return "", invalid("%s has no field %q", area, name)
	}
	if field.class == foundryPerson {
		if area == "worker_groups" && name == "members" {
			return foundryMembersPointer(call, value)
		}
		return "", personOnlyRefusal("changing " + area + "." + name + " (it decides " + field.why + ")")
	}
	id := mcpArgString(call.args, "id")
	if id == "" {
		return "", invalid("id names the %s to change", area)
	}
	m, err := s.providerManagerFor(ctx, call.actor)
	if err != nil {
		return "", err
	}
	agent, err := s.foundryAssistant(ctx, m.userID)
	if err != nil {
		return "", err
	}
	before, err := s.foundryFieldValue(ctx, call.actor, area, id, name)
	if err != nil {
		return "", err
	}
	after, err := s.applyFoundryField(ctx, call.actor, area, id, name, value)
	if err != nil {
		return "", err
	}
	change := foundryChange{Op: "update", Area: area, ID: id, Field: name, Class: field.class, Before: before, After: after}
	actionID, err := s.recordFoundryChange(ctx, call, agent, change)
	if err != nil {
		return "", err
	}
	return encodeJSON(map[string]any{"status": "applied", "actionId": actionID, "area": area, "id": id, "field": name, "value": after,
		"undo": "foundry_settings with op undo and this actionId reverts it while nothing else has changed the field"})
}

// foundrySettingsUndo reverts an immediate change if the field still holds the
// value that change set. A later change to the same field refuses the undo.
func (s *Server) foundrySettingsUndo(call mcpCall) (string, error) {
	ctx := call.r.Context()
	actionID := mcpArgString(call.args, "actionId")
	if actionID == "" {
		return "", invalid("actionId names the change to undo")
	}
	m, err := s.providerManagerFor(ctx, call.actor)
	if err != nil {
		return "", err
	}
	agent, err := s.foundryAssistant(ctx, m.userID)
	if err != nil {
		return "", err
	}
	_, raw, err := s.store.GetPersonalAgentAction(ctx, agent.ID, actionID)
	if err != nil {
		return "", err
	}
	var change foundryChange
	if err := json.Unmarshal(raw, &change); err != nil || (change.Op != "update" && change.Op != "issue") {
		return "", invalid("%s is not a Foundry settings change", actionID)
	}
	if change.Class != foundryImmediate {
		return "", invalid("%s is a %s change, which an agent does not undo", actionID, change.Class)
	}
	current, err := s.foundryFieldValue(ctx, call.actor, change.Area, change.ID, change.Field)
	if err != nil {
		return "", err
	}
	if !bytes.Equal(current, change.After) {
		return "", &statusError{http.StatusConflict, errors.New(change.Field + " changed after " + actionID + ": undo would overwrite a later change")}
	}
	restored, err := s.applyFoundryField(ctx, call.actor, change.Area, change.ID, change.Field, change.Before)
	if err != nil {
		return "", err
	}
	undo := foundryChange{Op: "undo", Area: change.Area, ID: change.ID, Field: change.Field, Class: foundryImmediate, Before: current, After: restored, Undoes: actionID}
	undoID, err := s.recordFoundryChange(ctx, call, agent, undo)
	if err != nil {
		return "", err
	}
	return encodeJSON(map[string]any{"status": "undone", "actionId": undoID, "undid": actionID, "area": change.Area, "id": change.ID, "field": change.Field, "value": restored})
}

// foundrySettingsPairCode issues a Feishu pairing code for the workspace's bot
// (area feishu). The person's own chats and the sessions they start may call
// it; the assistant's helpers may not. The person's chat then sends the code
// to the bot to bind it. The code is audited but cannot be undone.
func (s *Server) foundrySettingsPairCode(call mcpCall) (string, error) {
	ctx := call.r.Context()
	if area := mcpArgString(call.args, "area"); area != "feishu" {
		return "", invalid("pair_code is an op of area feishu, not %q", area)
	}
	workspaceID := mcpArgString(call.args, "workspaceId")
	if workspaceID == "" {
		return "", invalid("workspaceId names the workspace whose Feishu bot the chat pairs with")
	}
	session, err := s.store.GetAgentSessionRecord(ctx, call.actor.Identity.SessionID)
	if err != nil {
		return "", err
	}
	if _, helper := s.assistant.HelperOf(ctx, session); helper {
		return "", &statusError{http.StatusForbidden, errors.New("pair_code is for the person's own chats and the sessions they start: an assistant's helper does not pair a Feishu chat")}
	}
	scope, err := s.scopeOfContext(ctx)
	if err != nil {
		return "", err
	}
	if err := s.pairCodeRefusal(ctx, call.actor, scope, workspaceID); err != nil {
		return "", err
	}
	m, err := s.providerManagerFor(ctx, call.actor)
	if err != nil {
		return "", err
	}
	agent, err := s.foundryAssistant(ctx, m.userID)
	if err != nil {
		return "", err
	}
	issued, err := s.generateFeishuPairingCode(ctx, workspaceID, m.userID)
	if err != nil {
		return "", err
	}
	actionID, err := s.recordFoundryChange(ctx, call, agent, foundryChange{Op: "issue", Area: "feishu", ID: workspaceID, Field: "pair_code", Class: foundryIssued})
	if err != nil {
		return "", err
	}
	return encodeJSON(map[string]any{"status": "issued", "actionId": actionID, "workspaceId": workspaceID,
		"pairingCode": issued.PairingCode, "expiresAt": issued.PairingCodeExpiresAt,
		"pair": "the person's chat sends /pair <pairingCode> to the workspace's Foundry bot as a direct message before expiresAt; no undo"})
}

// pairCodeRefusal is why the actor may not issue a pairing code for the
// workspace's Feishu bot. An agent's scope is capped at Member (agentScope),
// but pairing is the person's act: the person the session acts for must be a
// Maintainer or higher there, read uncapped. Everything else keeps the cap. An
// Issue's session never pairs, so its Issue scope cannot widen this read.
func (s *Server) pairCodeRefusal(ctx context.Context, actor Actor, scope accessScope, workspaceID string) error {
	if actor.Kind != ActorAgent {
		return workspaceRefusal(scope, workspaceID, store.WorkspaceRoleMaintainer)
	}
	if err := workspaceRefusal(scope, workspaceID, store.WorkspaceRoleViewer); err != nil {
		return err
	}
	if scope.issueID != "" || scope.userID == "" {
		return &statusError{http.StatusForbidden, errors.New("pair_code is for the person's own chats and the sessions they start, not an Issue's session or one no person started")}
	}
	roles, err := s.store.WorkspaceRolesForUser(ctx, scope.userID)
	if err != nil {
		return err
	}
	return workspaceRefusal(accessScope{roles: roles}, workspaceID, store.WorkspaceRoleMaintainer)
}

// foundryMembersPointer answers an update of worker group members with the
// worker_groups call that makes it. Nothing changes here: that tool already
// saves members for the person's sessions, and this one does not duplicate it.
func foundryMembersPointer(call mcpCall, members json.RawMessage) (string, error) {
	id := mcpArgString(call.args, "id")
	if id == "" {
		return "", invalid("id names the worker group whose members change")
	}
	return encodeJSON(map[string]any{
		"status": "not_applied",
		"reason": "worker group members are saved with worker_groups; nothing changed here",
		"use": map[string]any{"tool": "worker_groups", "arguments": map[string]any{
			"action": "save", "id": id, "members": members,
		}},
	})
}

// foundryPatch is the one field a call changes: {"name": value}.
func foundryPatch(args map[string]json.RawMessage) (string, json.RawMessage, error) {
	raw, ok := args["patch"]
	if !ok {
		return "", nil, invalid(`patch names the field to change as {"field": value}`)
	}
	var patch map[string]json.RawMessage
	if err := json.Unmarshal(raw, &patch); err != nil || len(patch) != 1 {
		return "", nil, invalid(`patch changes one field per call, as {"field": value}`)
	}
	for name, value := range patch {
		return name, value, nil
	}
	return "", nil, invalid(`patch changes one field per call, as {"field": value}`)
}

// foundryAssistant is the person's default assistant: where immediate changes
// are audited. A change is refused without one, because its undo needs the log.
func (s *Server) foundryAssistant(ctx context.Context, userID string) (store.PersonalAgent, error) {
	agents, err := s.store.ListAssistants(ctx, userID)
	if err != nil {
		return store.PersonalAgent{}, err
	}
	if len(agents) == 0 {
		return store.PersonalAgent{}, &statusError{http.StatusConflict, errors.New("set up your assistant first: its change log is where a Foundry setting changed here is recorded and can be undone")}
	}
	return agents[0], nil
}

// recordFoundryChange appends the change to pa_actions and returns its id.
func (s *Server) recordFoundryChange(ctx context.Context, call mcpCall, agent store.PersonalAgent, change foundryChange) (string, error) {
	args, err := json.Marshal(change)
	if err != nil {
		return "", err
	}
	saved, err := s.store.RecordPersonalAgentAction(ctx, store.PersonalAgentActionRecord{
		UserID: agent.UserID, AssistantID: agent.ID, SessionID: call.actor.Identity.SessionID, Tool: "foundry_settings",
		ArgsSummary: change.Area + "." + change.Field + " " + change.Op, Decision: store.PersonalAgentAuto, Outcome: store.PersonalAgentOutcomeApplied,
	}, args)
	if err != nil {
		return "", err
	}
	return saved.ID, nil
}

// foundryFieldValue reads an immediate field as JSON, the form undo compares.
func (s *Server) foundryFieldValue(ctx context.Context, actor Actor, area, id, field string) (json.RawMessage, error) {
	switch area + "." + field {
	case "worker_groups.label":
		group, err := s.ownedWorkerGroup(ctx, actor, id)
		if err != nil {
			return nil, err
		}
		return json.Marshal(group.Label)
	case "devices.name", "devices.labels":
		device, err := s.ownedDeviceByID(ctx, actor, id)
		if err != nil {
			return nil, err
		}
		if field == "name" {
			return json.Marshal(device.Label)
		}
		placements, err := s.devicePlacements(ctx, []store.DeviceProjection{device}, time.Now())
		if err != nil {
			return nil, err
		}
		return json.Marshal(placements[device.ID].Labels)
	}
	return nil, invalid("%s.%s is not a field Foundry settings reads", area, field)
}

// applyFoundryField writes an immediate field through the same functions its
// route runs, and answers the value it now holds.
func (s *Server) applyFoundryField(ctx context.Context, actor Actor, area, id, field string, value json.RawMessage) (json.RawMessage, error) {
	m, err := s.providerManagerFor(ctx, actor)
	if err != nil {
		return nil, err
	}
	switch area + "." + field {
	case "worker_groups.label":
		var label string
		if err := json.Unmarshal(value, &label); err != nil {
			return nil, invalid("label is a string")
		}
		group, err := s.ownedWorkerGroup(ctx, actor, id)
		if err != nil {
			return nil, err
		}
		view, err := s.workerGroupView(ctx, group)
		if err != nil {
			return nil, err
		}
		saved, err := s.saveWorkerGroup(ctx, m, id, store.WorkerGroupInput{Label: label, Members: view.Members})
		if err != nil {
			return nil, err
		}
		return json.Marshal(saved.Label)
	case "devices.name":
		var name string
		if err := json.Unmarshal(value, &name); err != nil {
			return nil, invalid("name is a string")
		}
		if _, err := s.ownedDeviceByID(ctx, actor, id); err != nil {
			return nil, err
		}
		item, err := s.renameDevice(ctx, id, name)
		if err != nil {
			return nil, err
		}
		return json.Marshal(item.Label)
	case "devices.labels":
		var labels []store.DeviceLabel
		if err := json.Unmarshal(value, &labels); err != nil {
			return nil, invalid("labels are a list of {key, value}")
		}
		if _, err := s.ownedDeviceByID(ctx, actor, id); err != nil {
			return nil, err
		}
		placement, err := s.setDeviceLabels(ctx, id, labels, m.userID)
		if err != nil {
			return nil, err
		}
		return json.Marshal(placement.Labels)
	}
	return nil, invalid("%s.%s is not a field Foundry settings changes", area, field)
}

// ownedDeviceByID is a device the person owns and can act on now: the device
// routes' rules (ownership, then availability). Agent sessions own no device
// in their access scope, so ownership is the person's device identity.
func (s *Server) ownedDeviceByID(ctx context.Context, actor Actor, id string) (store.DeviceProjection, error) {
	m, err := s.providerManagerFor(ctx, actor)
	if err != nil {
		return store.DeviceProjection{}, err
	}
	devices, err := s.ownedDevices(ctx, m.userID, id)
	if err != nil {
		return store.DeviceProjection{}, err
	}
	if len(devices) == 0 {
		return store.DeviceProjection{}, &statusError{http.StatusNotFound, errors.New("device not found")}
	}
	if err := store.RequireDeviceAvailable(ctx, s.store, id); err != nil {
		return store.DeviceProjection{}, err
	}
	return devices[0], nil
}

// ownedDevices lists the devices the person owns (their device identities),
// one when id is set.
func (s *Server) ownedDevices(ctx context.Context, userID, id string) ([]store.DeviceProjection, error) {
	ownedIDs, err := s.store.DevicesOwnedBy(ctx, userID)
	if err != nil {
		return nil, err
	}
	owned := map[string]bool{}
	for _, deviceID := range ownedIDs {
		owned[deviceID] = true
	}
	all, err := s.store.ListDevices(ctx)
	if err != nil {
		return nil, err
	}
	devices := []store.DeviceProjection{}
	for _, device := range all {
		if owned[device.ID] && (id == "" || device.ID == id) {
			devices = append(devices, device)
		}
	}
	return devices, nil
}

// settingsWorkspace is the workspace a workspace setting names, when the scope
// holds at least need on it.
func (s *Server) settingsWorkspace(ctx context.Context, scope accessScope, id, need string) (store.WorkspaceProjection, error) {
	if strings.TrimSpace(id) == "" {
		return store.WorkspaceProjection{}, invalid("workspaceId names the workspace")
	}
	if err := workspaceRefusal(scope, id, need); err != nil {
		return store.WorkspaceProjection{}, err
	}
	return s.store.GetWorkspace(ctx, id)
}
