package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The resource tools: a session leases instances on its person's devices
// (acquire_resource, release_resource, resource_status) and operates them
// step by step (operate_resource), through the hosting device's worker.

// Bounds of operate_resource, named in the tools' limits.
const (
	maxResourceActions      = 10
	maxResourceImageBytes   = 2 << 20
	maxResourceResultBytes  = 8 << 20
	defaultResourceDeadline = 60 * time.Second
	maxResourceHoldSeconds  = 7200
	// A compute run's default and the time a device gets beyond it.
	defaultComputeRun   = 10 * time.Minute
	computeRunSlack     = 30 * time.Second
	computeStepDeadline = 2 * time.Minute
	computeGitDeadline  = 15 * time.Minute
)

// resourceToolHolder is the session a resource tool acts for, and the
// person whose devices it may lease.
type resourceToolHolder struct {
	sessionID string
	personID  string
	owned     map[string]bool
	scope     accessScope
}

func (s *Server) resourceHolder(ctx context.Context, actor Actor) (resourceToolHolder, error) {
	if s.leases == nil {
		return resourceToolHolder{}, &mcpToolError{http.StatusConflict, "this server keeps no resource leases"}
	}
	if !actor.Agent() {
		return resourceToolHolder{}, &mcpToolError{http.StatusBadRequest, "resources are leased to sessions: call this tool from a Foundry session"}
	}
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return resourceToolHolder{}, err
	}
	holder := resourceToolHolder{sessionID: actor.Identity.SessionID, personID: scope.agentFor, owned: map[string]bool{}, scope: scope}
	if scope.issueID != "" {
		return holder, &mcpToolError{http.StatusForbidden, "a session working in an Issue does not lease devices' resources"}
	}
	ownership, ok := s.store.(store.OwnershipStore)
	if holder.personID == "" || !ok {
		return holder, nil
	}
	devices, err := ownership.DevicesOwnedBy(ctx, holder.personID)
	if err != nil {
		return holder, err
	}
	for _, device := range devices {
		holder.owned[device] = true
	}
	return holder, nil
}

// resourceFor reads an instance the holder's person owns; others read as
// not found, so their existence does not leak.
func (s *Server) resourceFor(ctx context.Context, holder resourceToolHolder, id string) (store.ResourceInstance, error) {
	list, err := s.resources.List(ctx, store.ResourceFilter{})
	if err != nil {
		return store.ResourceInstance{}, err
	}
	for _, instance := range list.Instances {
		if instance.ID == id && instance.Source.Kind == "device" && holder.owned[instance.Source.ID] {
			return instance, nil
		}
	}
	return store.ResourceInstance{}, &mcpToolError{http.StatusNotFound, "resource " + id + " not found among your devices' resources (list_resources lists them)"}
}

// leaseToolError turns a lease refusal into what the agent reads.
func leaseToolError(err error) error {
	var refusal *resources.LeaseError
	if !errors.As(err, &refusal) {
		return err
	}
	message := refusal.Message
	if refusal.Holder != nil {
		raw, _ := json.Marshal(map[string]any{"code": refusal.Code, "holder": refusal.Holder, "queuePosition": refusal.Position})
		message += "\n" + string(raw)
	} else {
		message = refusal.Code + ": " + message
	}
	return &mcpToolError{http.StatusConflict, message}
}

type resourceSummary struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Type       string   `json:"type"`
	Platform   string   `json:"platform"`
	Device     string   `json:"device"`
	DeviceID   string   `json:"deviceId"`
	Backend    string   `json:"backend,omitempty"`
	Operations []string `json:"operations,omitempty"`
}

func summarizeResource(instance store.ResourceInstance) resourceSummary {
	summary := resourceSummary{ID: instance.ID, Name: instance.Name, Type: instance.Type, Platform: instance.Platform,
		Device: instance.Source.Label, DeviceID: instance.Source.ID}
	if backend, err := resources.OperableBackend(instance); err == nil {
		summary.Backend = strings.TrimSuffix(backend.ID+"@"+backend.Version, "@")
	}
	if spec, ok := resources.Spec(instance.Type); ok {
		summary.Operations = spec.OperationNames()
	}
	return summary
}

// acquireResourceForMCP leases what the arguments name: resourceId,
// resourceIds (all or none), or the first usable instance of a type
// (optionally on deviceId).
func (s *Server) acquireResourceForMCP(r *http.Request, actor Actor, args map[string]json.RawMessage) (string, error) {
	ctx := r.Context()
	holder, err := s.resourceHolder(ctx, actor)
	if err != nil {
		return "", err
	}
	ids := mcpArgList(args, "resourceIds")
	if id := mcpArgString(args, "resourceId"); id != "" {
		ids = append([]string{id}, ids...)
	}
	instances := []store.ResourceInstance{}
	if len(ids) == 0 {
		chosen, err := s.chooseResource(ctx, holder, mcpArgString(args, "type"), mcpArgString(args, "deviceId"))
		if err != nil {
			return "", err
		}
		ids = []string{chosen.ID}
	}
	for _, id := range ids {
		instance, err := s.resourceFor(ctx, holder, id)
		if err != nil {
			return "", err
		}
		instances = append(instances, instance)
	}
	request := resources.AcquireRequest{
		SessionID: holder.sessionID, ResourceIDs: ids, Reason: mcpArgString(args, "reason"),
		Wait: time.Duration(min(mcpArgNumber(args, "waitMs", 0), maxMCPWaitMs)) * time.Millisecond,
	}
	if _, set := args["holdFor"]; set {
		seconds := min(mcpArgNumber(args, "holdFor", 0), maxResourceHoldSeconds)
		hold := time.Duration(seconds) * time.Second
		request.HoldFor = &hold
	}
	leases, err := s.leases.Acquire(ctx, request)
	if err != nil {
		return "", leaseToolError(err)
	}
	views := []resources.View{}
	for _, lease := range leases {
		views = append(views, s.leases.ViewOf(ctx, lease))
	}
	summaries := []resourceSummary{}
	for _, instance := range instances {
		summaries = append(summaries, summarizeResource(instance))
	}
	next := "Call operate_resource with this leaseId: take a screenshot first (with pid and window_id from list_windows to get one window and its coordinate space), then act. Call release_resource as soon as you are done."
	if instances[0].Type == "compute" {
		next = "Call operate_resource with this leaseId: put_files or git_sync what you need into a scratch folder, then run commands there (a run blocks up to its timeoutSec; start long jobs in the background and collect their output with a later run). Call release_resource as soon as you are done."
	}
	result := map[string]any{
		"lease":     views[0],
		"resource":  summaries[0],
		"next":      next,
		"leases":    views,
		"resources": summaries,
	}
	if len(views) == 1 {
		delete(result, "leases")
		delete(result, "resources")
	}
	return encodeJSON(result)
}

// chooseResource picks the first usable instance of a type on the holder's
// devices, free ones first.
func (s *Server) chooseResource(ctx context.Context, holder resourceToolHolder, resourceType, deviceID string) (store.ResourceInstance, error) {
	if resourceType == "" {
		resourceType = "computer_use"
	}
	list, err := s.resources.List(ctx, store.ResourceFilter{Type: resourceType, SourceID: deviceID})
	if err != nil {
		return store.ResourceInstance{}, err
	}
	var busy *store.ResourceInstance
	for index, instance := range list.Instances {
		if instance.Source.Kind != "device" || !holder.owned[instance.Source.ID] {
			continue
		}
		if _, err := resources.OperableBackend(instance); err != nil {
			continue
		}
		switch instance.State {
		case store.ResourceAvailable:
			return instance, nil
		case store.ResourceBusy:
			if busy == nil {
				busy = &list.Instances[index]
			}
		}
	}
	if busy != nil {
		return *busy, nil
	}
	return store.ResourceInstance{}, &mcpToolError{http.StatusNotFound, "no " + resourceType + " resource on your devices is ready to lease; list_resources shows each one's readiness and what is missing"}
}

func (s *Server) releaseResourceForMCP(r *http.Request, actor Actor, args map[string]json.RawMessage) (string, error) {
	holder, err := s.resourceHolder(r.Context(), actor)
	if err != nil {
		return "", err
	}
	lease, err := s.leases.Release(r.Context(), mcpArgString(args, "leaseId"), holder.sessionID)
	if err != nil {
		return "", leaseToolError(err)
	}
	return encodeJSON(map[string]any{"lease": s.leases.ViewOf(r.Context(), lease)})
}

// resourceStatusForMCP answers an instance's state, who holds it, the
// caller's own lease on it and its latest operations.
func (s *Server) resourceStatusForMCP(r *http.Request, actor Actor, args map[string]json.RawMessage) (string, error) {
	ctx := r.Context()
	holder, err := s.resourceHolder(ctx, actor)
	if err != nil {
		return "", err
	}
	resourceID := mcpArgString(args, "resourceId")
	var own *resources.View
	if leaseID := mcpArgString(args, "leaseId"); leaseID != "" {
		lease, err := s.leases.Lease(ctx, leaseID)
		if err != nil || lease.HolderSessionID != holder.sessionID {
			return "", &mcpToolError{http.StatusNotFound, "lease " + leaseID + " not found among this session's leases"}
		}
		view := s.leases.ViewOf(ctx, lease)
		own, resourceID = &view, lease.ResourceID
	}
	if resourceID == "" {
		return "", &mcpToolError{http.StatusBadRequest, "name resourceId or leaseId"}
	}
	instance, err := s.resourceFor(ctx, holder, resourceID)
	if err != nil {
		return "", err
	}
	if own == nil && instance.Holder != nil && instance.Holder.SessionID == holder.sessionID {
		if lease, err := s.leases.Lease(ctx, instance.Holder.LeaseID); err == nil {
			view := s.leases.ViewOf(ctx, lease)
			own = &view
		}
	}
	records, err := s.leases.Operations(ctx, instance.ID, 10)
	if err != nil {
		return "", err
	}
	type recent struct {
		Op        string         `json:"op"`
		Args      map[string]any `json:"args,omitempty"`
		Status    string         `json:"status"`
		ErrorCode string         `json:"errorCode,omitempty"`
		At        string         `json:"at"`
		Mine      bool           `json:"mine"`
	}
	latest := []recent{}
	for _, record := range records {
		latest = append(latest, recent{record.Op, record.Args, record.Status, record.ErrorCode, record.StartedAt, record.SessionID == holder.sessionID})
	}
	status := map[string]any{
		"resource":    summarizeResource(instance),
		"state":       instance.State,
		"stateReason": instance.StateReason,
		"readiness":   instance.Readiness,
		"backends":    instance.Backends,
		"queue":       instance.Queue,
		"resetting":   instance.Resetting,
		"recent":      latest,
	}
	if instance.Holder != nil {
		status["holder"] = instance.Holder
	}
	if own != nil {
		status["yourLease"] = own
	}
	return encodeJSON(status)
}

// operateResourceForMCP runs operations on a leased instance and answers
// their results as text, with the screenshots as image content.
func (s *Server) operateResourceForMCP(r *http.Request, actor Actor, args map[string]json.RawMessage) ([]any, error) {
	ctx := r.Context()
	holder, err := s.resourceHolder(ctx, actor)
	if err != nil {
		return nil, err
	}
	actions, err := resourceActions(args)
	if err != nil {
		return nil, err
	}
	ticket, err := s.leases.Begin(ctx, mcpArgString(args, "leaseId"), holder.sessionID)
	if err != nil {
		return nil, leaseToolError(err)
	}
	refuse := func(err error) ([]any, error) {
		_ = s.leases.Finish(context.WithoutCancel(ctx), ticket, nil)
		return nil, err
	}
	for _, action := range actions {
		if _, ok := ticket.Spec.Operation(action.Op); !ok {
			return refuse(&mcpToolError{http.StatusBadRequest, fmt.Sprintf("%s has no operation %q; it has %s", ticket.Instance.Name, action.Op, strings.Join(ticket.Spec.OperationNames(), ", "))})
		}
	}
	if raw, _ := json.Marshal(actions); len(raw) > ticket.Spec.MaxArgsBytes {
		return refuse(&mcpToolError{http.StatusBadRequest, fmt.Sprintf("the actions' arguments exceed %d KB; send files in pieces (put_files)", ticket.Spec.MaxArgsBytes>>10)})
	}
	if ticket.Spec.RemoteCommands {
		if err := s.computeWorkspaces(ctx, holder, ticket.Instance, actions); err != nil {
			return refuse(err)
		}
	}
	deadline := operateDeadline(ticket.Spec, actions)
	request := store.ResourceOperateRequest{
		ResourceID: ticket.Instance.ID, Key: ticket.Instance.Key, Type: ticket.Instance.Type, Backend: ticket.Backend.ID,
		LeaseID: ticket.Lease.ID, Generation: ticket.Lease.Generation, Actions: actions, DeadlineMs: deadline.Milliseconds(),
	}
	started := time.Now()
	operateCtx, cancel := context.WithTimeout(ctx, deadline+10*time.Second)
	result, operateErr := s.leases.Router.Operate(operateCtx, ticket.Lease.SourceID, request)
	cancel()
	duration := time.Since(started).Milliseconds()
	records := make([]store.ResourceOperationRecord, 0, len(actions))
	for index, action := range actions {
		spec, _ := ticket.Spec.Operation(action.Op)
		record := store.ResourceOperationRecord{Op: action.Op, Args: spec.AuditArgs(action.Args), Status: "error",
			StartedAt: started.UTC().Format(time.RFC3339Nano), DurationMs: duration}
		switch {
		case operateErr != nil:
			record.ErrorCode = "device_error"
		case result.Error != "":
			record.ErrorCode = cmpOr(result.ErrorCode, "backend_error")
		case index < len(result.Results):
			outcome := result.Results[index]
			if outcome.OK {
				record.Status = "ok"
			}
			record.ErrorCode = outcome.ErrorCode
			record.Outcome = outcome.Outcome
			for _, image := range outcome.Images {
				record.BytesOut += int64(base64.StdEncoding.DecodedLen(len(image.Data)))
			}
			record.BytesOut += outcomeBytes(outcome.Outcome)
		default:
			record.ErrorCode = "not_run"
		}
		records = append(records, record)
	}
	if err := s.leases.Finish(context.WithoutCancel(ctx), ticket, records); err != nil {
		return nil, err
	}
	if operateErr != nil {
		return nil, &mcpToolError{http.StatusConflict, "device_error: " + operateErr.Error()}
	}
	if result.Error != "" {
		return nil, &mcpToolError{http.StatusConflict, cmpOr(result.ErrorCode, "backend_error") + ": " + result.Error}
	}
	return operateContent(s.leases.ViewOf(ctx, ticket.Lease), result, ticket.Spec.MaxResultText), nil
}

// operateDeadline is how long the device gets for actions: a minute,
// longer for waits; for compute, each run's timeoutSec and the time other
// steps take; at most the type's MaxDeadline.
func operateDeadline(spec resources.TypeSpec, actions []store.ResourceAction) time.Duration {
	deadline := defaultResourceDeadline
	if spec.RemoteCommands {
		deadline = 0
	}
	for _, action := range actions {
		switch {
		case action.Op == "wait":
			if ms, ok := action.Args["ms"].(float64); ok && ms > 0 {
				deadline += time.Duration(min(ms, 5000)) * time.Millisecond
			}
		case !spec.RemoteCommands:
		case action.Op == "run":
			run := defaultComputeRun
			if seconds, ok := action.Args["timeoutSec"].(float64); ok && seconds > 0 {
				run = min(time.Duration(seconds)*time.Second, resources.MaxComputeRun)
			}
			deadline += run + computeRunSlack
		case action.Op == "git_sync":
			deadline += computeGitDeadline
		default:
			deadline += computeStepDeadline
		}
	}
	return min(deadline, spec.MaxDeadline)
}

// computeWorkspaces lets a compute action work in a workspace only when
// the workspace is on the resource's device and the session may work in
// it (Member); the server, not the caller, names its folder to the
// worker (workspacePath), which checks it serves that folder.
func (s *Server) computeWorkspaces(ctx context.Context, holder resourceToolHolder, instance store.ResourceInstance, actions []store.ResourceAction) error {
	for index := range actions {
		action := &actions[index]
		if action.Args == nil {
			continue
		}
		delete(action.Args, "workspacePath")
		raw, named := action.Args["workspaceId"]
		if !named {
			continue
		}
		workspaceID, _ := raw.(string)
		workspaceID = strings.TrimSpace(workspaceID)
		if workspaceID == "" {
			delete(action.Args, "workspaceId")
			continue
		}
		if !holder.scope.can(workspaceID, store.WorkspaceRoleMember) {
			return &mcpToolError{http.StatusForbidden, "workspace " + workspaceID + " is not one this session may work in (Member)"}
		}
		workspace, err := s.store.GetWorkspace(ctx, workspaceID)
		if err != nil {
			return &mcpToolError{http.StatusNotFound, "workspace " + workspaceID + " not found"}
		}
		if workspace.DeviceID != instance.Source.ID || strings.TrimSpace(workspace.LocalPath) == "" {
			return &mcpToolError{http.StatusBadRequest, fmt.Sprintf("workspace %s (%s) is not on %s; name a workspace on that device, or use a scratch folder", workspaceID, workspace.Name, instance.Source.Label)}
		}
		action.Args["workspacePath"] = workspace.LocalPath
	}
	return nil
}

// outcomeBytes is what a compute action moved, from its outcome: the
// output a command wrote, a file's bytes.
func outcomeBytes(outcome map[string]any) int64 {
	total := int64(0)
	for _, name := range []string{"stdoutBytes", "stderrBytes", "bytes"} {
		if value, ok := outcome[name].(float64); ok && value > 0 {
			total += int64(value)
		}
	}
	return total
}

// resourceActions reads op/args or actions, and screenshotAfter.
func resourceActions(args map[string]json.RawMessage) ([]store.ResourceAction, error) {
	var actions []store.ResourceAction
	if raw, ok := args["actions"]; ok && len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &actions); err != nil {
			return nil, &mcpToolError{http.StatusBadRequest, "actions must be a list of {op, args}"}
		}
	}
	if op := mcpArgString(args, "op"); op != "" {
		action := store.ResourceAction{Op: op}
		if raw, ok := args["args"]; ok && len(raw) > 0 && string(raw) != "null" {
			if err := json.Unmarshal(raw, &action.Args); err != nil {
				return nil, &mcpToolError{http.StatusBadRequest, "args must be an object"}
			}
		}
		actions = append([]store.ResourceAction{action}, actions...)
	}
	if len(actions) == 0 {
		return nil, &mcpToolError{http.StatusBadRequest, "name an op (with its args) or actions"}
	}
	if mcpArgBool(args, "screenshotAfter") {
		after := store.ResourceAction{Op: "screenshot", Args: map[string]any{}}
		for _, name := range []string{"pid", "window_id"} {
			if value, ok := actions[len(actions)-1].Args[name]; ok {
				after.Args[name] = value
			}
		}
		actions = append(actions, after)
	}
	if len(actions) > maxResourceActions {
		return nil, &mcpToolError{http.StatusBadRequest, fmt.Sprintf("at most %d actions in one call", maxResourceActions)}
	}
	return actions, nil
}

// operateContent is the MCP content of an operation: one text block with
// the lease and each action's result, then each screenshot as an image.
// An image over 2 MB, or past 8 MB in all, is left out with an error.
func operateContent(lease resources.View, result store.ResourceOperateResult, maxText int) []any {
	type imageNote struct {
		FrameID  string  `json:"frameId"`
		Width    int     `json:"width"`
		Height   int     `json:"height"`
		Scale    float64 `json:"scale"`
		MimeType string  `json:"mimeType"`
		Error    string  `json:"error,omitempty"`
	}
	type actionResult struct {
		Op        string      `json:"op"`
		OK        bool        `json:"ok"`
		Text      string      `json:"text,omitempty"`
		Error     string      `json:"error,omitempty"`
		ErrorCode string      `json:"errorCode,omitempty"`
		Images    []imageNote `json:"images,omitempty"`
	}
	images := []any{}
	total := 0
	results := []actionResult{}
	for _, outcome := range result.Results {
		entry := actionResult{Op: outcome.Op, OK: outcome.OK, Error: outcome.Error, ErrorCode: outcome.ErrorCode, Text: outcome.Text}
		if len(entry.Text) > maxText {
			entry.Text = entry.Text[:maxText] + "\n…[cut; narrow it with query or max_elements]"
		}
		for _, image := range outcome.Images {
			note := imageNote{FrameID: image.FrameID, Width: image.Width, Height: image.Height, Scale: image.Scale, MimeType: image.MimeType}
			size := base64.StdEncoding.DecodedLen(len(image.Data))
			switch {
			case size > maxResourceImageBytes:
				note.Error = fmt.Sprintf("too_large: %d KB is over %d MB; ask for a smaller max_image_dimension", size>>10, maxResourceImageBytes>>20)
			case total+size > maxResourceResultBytes:
				note.Error = fmt.Sprintf("too_large: this call's images passed %d MB; take fewer screenshots per call", maxResourceResultBytes>>20)
			default:
				total += size
				images = append(images, map[string]any{"type": "image", "data": image.Data, "mimeType": image.MimeType})
			}
			entry.Images = append(entry.Images, note)
		}
		results = append(results, entry)
	}
	text, _ := json.MarshalIndent(map[string]any{"lease": lease, "results": results, "opened": result.Opened}, "", "  ")
	return append([]any{map[string]any{"type": "text", "text": string(text)}}, images...)
}

func cmpOr(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

// resourceNoticeContent is what a holder session is told with every
// Foundry tool result, when there is something to tell.
func (s *Server) resourceNoticeContent(ctx context.Context, actor Actor) []any {
	if s.leases == nil || !actor.Agent() {
		return nil
	}
	notices := s.leases.Notices(ctx, actor.Identity.SessionID)
	if len(notices) == 0 {
		return nil
	}
	return []any{map[string]any{"type": "text", "text": "Resource notices:\n- " + strings.Join(notices, "\n- ")}}
}

// mcpResourceHolders adds who holds each instance to list_resources.
func mcpResourceHolder(instance store.ResourceInstance) (*store.ResourceHolder, []string) {
	if spec, ok := resources.Spec(instance.Type); ok && slices.ContainsFunc(instance.Backends, func(backend store.ResourceBackend) bool {
		return backend.Mode == "remote_ops"
	}) {
		return instance.Holder, spec.OperationNames()
	}
	return instance.Holder, nil
}
