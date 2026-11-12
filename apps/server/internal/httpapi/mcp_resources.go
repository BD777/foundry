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

	"github.com/foundry-dev/foundry/apps/server/internal/permission"
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
	// assistantDevices are, for a session working for an assistant, the
	// devices with a workspace its package allows: resources without an
	// identity there are its to lease. nil for every other session.
	assistantDevices map[string]bool
}

// leasable reports whether the holder may lease instance: one on the
// person's devices and, for a session working for an assistant, an
// identity resource its package lists (scope listed) or any resource on a
// device with a workspace the package allows.
func (h resourceToolHolder) leasable(instance store.ResourceInstance) bool {
	if instance.Source.Kind != "device" || !h.owned[instance.Source.ID] {
		return false
	}
	access := h.scope.assistant
	if !access.Applicable {
		return true
	}
	if permission.IdentityResourceType(instance.Type) && access.IdentityResourceListed() {
		return access.IdentityResourceAllowed(instance.ID)
	}
	return h.assistantDevices[instance.Source.ID]
}

func (s *Server) resourceHolder(ctx context.Context, actor Actor) (resourceToolHolder, error) {
	if !actor.Agent() {
		return resourceToolHolder{}, &statusError{http.StatusBadRequest, errors.New("resources are leased to sessions: call this tool from a Foundry session")}
	}
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return resourceToolHolder{}, err
	}
	holder := resourceToolHolder{sessionID: actor.Identity.SessionID, personID: scope.agentFor, owned: map[string]bool{}, scope: scope}
	if scope.issueID != "" {
		return holder, &statusError{http.StatusForbidden, errors.New("a session working in an Issue does not lease devices' resources")}
	}
	if holder.personID == "" {
		return holder, nil
	}
	devices, err := s.store.DevicesOwnedBy(ctx, holder.personID)
	if err != nil {
		return holder, err
	}
	for _, device := range devices {
		holder.owned[device] = true
	}
	if scope.assistant.Applicable {
		workspaces, err := s.store.ListWorkspaces(ctx)
		if err != nil {
			return holder, err
		}
		holder.assistantDevices = map[string]bool{}
		for _, workspace := range workspaces {
			if scope.roles[workspace.ID] != "" && scope.assistant.WorkspaceAllowed(workspace.ID) {
				holder.assistantDevices[workspace.DeviceID] = true
			}
		}
	}
	return holder, nil
}

func assistantResourceRefusal(access permission.Access, instance store.ResourceInstance) string {
	if permission.IdentityResourceType(instance.Type) && access.IdentityResourceListed() {
		return "resource " + instance.ID + " (" + instance.Type + ") acts as the person, and this assistant's permissions do not include it; the person allows it in the assistant's settings → Permissions → Identity resources"
	}
	return "resource " + instance.ID + " is on a device where this assistant's permissions include no workspace; the person adds a workspace on that device in the assistant's settings → Permissions"
}

// resourceFor reads an instance the holder's person owns; others read as
// not found, so their existence does not leak.
func (s *Server) resourceFor(ctx context.Context, holder resourceToolHolder, id string) (store.ResourceInstance, error) {
	list, err := s.resources.List(ctx, store.ResourceFilter{})
	if err != nil {
		return store.ResourceInstance{}, err
	}
	for _, instance := range list.Instances {
		if instance.ID != id || instance.Source.Kind != "device" || !holder.owned[instance.Source.ID] {
			continue
		}
		if !holder.leasable(instance) {
			return store.ResourceInstance{}, &statusError{http.StatusForbidden, errors.New(assistantResourceRefusal(holder.scope.assistant, instance))}
		}
		return instance, nil
	}
	return store.ResourceInstance{}, &statusError{http.StatusNotFound, errors.New("resource " + id + " not found among your devices' resources (list_resources lists them)")}
}

// A lease's command token (acquire_resource forCommands) lets a command the
// session runs, such as scripts/remote-check.sh, work one compute lease
// through the foundry CLI: the session's own token never reaches its
// commands (session-ambient.ts), so the session hands over this narrower
// one explicitly. It calls only these tools, only on its lease, and only
// while the session holds that lease.
const commandLeaseRoute = "POST /api/mcp"

var commandLeaseTools = map[string]bool{"operate_resource": true, "release_resource": true, "resource_status": true}

// checkCommandLease holds a lease's command token to its lease.
func (s *Server) checkCommandLease(ctx context.Context, actor Actor, args map[string]json.RawMessage) error {
	leaseID := actor.CommandLease()
	if leaseID == "" {
		return nil
	}
	if named := mcpArgString(args, "leaseId"); named != leaseID {
		return &statusError{http.StatusForbidden, errors.New("this command token acts on lease " + leaseID + " only; name it as leaseId")}
	}
	lease, err := s.leases.Lease(ctx, leaseID)
	if err != nil || lease.HolderSessionID != actor.Identity.SessionID || !store.LeaseLive(lease.State) {
		return &statusError{http.StatusUnauthorized, errors.New("lease " + leaseID + " has ended, so its command token no longer works; the session acquires a new lease")}
	}
	return nil
}

// leaseToolError turns a lease refusal into what the agent reads.
func leaseToolError(err error) error {
	var reconnecting *resources.DeviceReconnectingError
	if errors.As(err, &reconnecting) {
		return &statusError{http.StatusConflict, reconnecting}
	}
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
	return &statusError{http.StatusConflict, errors.New(message)}
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
		summary.Operations = resourceOperationNames(instance, spec)
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
	instances, err = s.prepareComputerUseForLease(ctx, holder, instances)
	if err != nil {
		return "", err
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
	forCommands := mcpArgBool(args, "forCommands")
	if forCommands && (len(instances) != 1 || instances[0].Type != "compute") {
		return "", &statusError{http.StatusBadRequest, errors.New("forCommands hands one compute lease to your commands: name a single compute resource")}
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
	if forCommands {
		token, err := s.store.MintLeaseCommandToken(ctx, holder.sessionID, leases[0].ID)
		if err != nil {
			_, _ = s.leases.Release(context.WithoutCancel(ctx), leases[0].ID, holder.sessionID)
			return "", err
		}
		result["commandToken"] = token
		result["next"] = "Pass commandToken as FOUNDRY_LEASE_TOKEN to a command that runs the foundry CLI's resource operate, status and release on this leaseId (for example scripts/remote-check.sh " + leases[0].ID + "); it works only on this lease and only while you hold it. Release the lease when the command is done."
	}
	return encodeJSON(result)
}

// cuaDriverLeasePrepareRequest is the worker's refresh mode that starts
// CuaDriver when needed, re-probes it within 15 seconds, and updates the
// scanner before answering. It is not the person's Request access flow.
const cuaDriverLeasePrepareRequest = "cua-driver:prepare"

// cuaDriverNotRunning recognizes the one unready state an agent can fix on
// its own: the backend is installed but its daemon has not been started.
func cuaDriverNotRunning(instance store.ResourceInstance) bool {
	if instance.Type != "computer_use" {
		return false
	}
	if slices.Contains(instance.Readiness.Missing, "cua_driver_not_running") {
		return true
	}
	for _, backend := range instance.Backends {
		if backend.ID == "cua-driver" &&
			slices.Contains(backend.Readiness.Missing, "cua_driver_not_running") {
			return true
		}
	}
	return false
}

// prepareComputerUseForLease starts a stopped CuaDriver before the lease
// gate reads readiness. The worker waits for the daemon and reports the
// fresh detector result; this side waits briefly for that report to land so
// acquire is decided on the post-start state, not the two-minute snapshot.
func (s *Server) prepareComputerUseForLease(
	ctx context.Context,
	holder resourceToolHolder,
	instances []store.ResourceInstance,
) ([]store.ResourceInstance, error) {
	preparedDevices := map[string]bool{}
	for _, instance := range instances {
		if instance.Type != "computer_use" || !cuaDriverNotRunning(instance) ||
			preparedDevices[instance.Source.ID] {
			continue
		}
		preparedDevices[instance.Source.ID] = true
		if _, err := s.hub.RefreshDeviceResources(ctx, instance.Source.ID, cuaDriverLeasePrepareRequest); err != nil {
			return nil, &statusError{
				http.StatusConflict,
				fmt.Errorf("%s: could not start CuaDriver for the lease: %w", instance.Source.Label, err),
			}
		}
	}
	if len(preparedDevices) == 0 {
		return instances, nil
	}
	for index, instance := range instances {
		updated, err := s.preparedResource(ctx, holder, instance.ID)
		if err != nil {
			return nil, err
		}
		instances[index] = updated
	}
	return instances, nil
}

func (s *Server) preparedResource(
	ctx context.Context,
	holder resourceToolHolder,
	id string,
) (store.ResourceInstance, error) {
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		instance, err := s.resourceFor(ctx, holder, id)
		if err != nil || !cuaDriverNotRunning(instance) {
			return instance, err
		}
		select {
		case <-ctx.Done():
			return store.ResourceInstance{}, ctx.Err()
		case <-deadline.C:
			return instance, nil
		case <-ticker.C:
		}
	}
}

// chooseResource picks the first usable instance of a type on the holder's
// devices, free ones first. A stopped CuaDriver is the last candidate: the
// caller starts it and then re-evaluates its readiness.
func (s *Server) chooseResource(ctx context.Context, holder resourceToolHolder, resourceType, deviceID string) (store.ResourceInstance, error) {
	if resourceType == "" {
		resourceType = "computer_use"
	}
	list, err := s.resources.List(ctx, store.ResourceFilter{Type: resourceType, SourceID: deviceID})
	if err != nil {
		return store.ResourceInstance{}, err
	}
	var busy *store.ResourceInstance
	var startable *store.ResourceInstance
	for index, instance := range list.Instances {
		if !holder.leasable(instance) {
			continue
		}
		if _, err := resources.OperableBackend(instance); err != nil {
			if startable == nil && cuaDriverNotRunning(instance) {
				startable = &list.Instances[index]
			}
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
	if startable != nil {
		return *startable, nil
	}
	message := "no " + resourceType + " resource on your devices is ready to lease; list_resources shows each one's readiness and what is missing"
	if holder.scope.assistant.Applicable {
		message += ". This session works for an assistant: it leases only identity resources its permissions list and other resources on devices with a workspace they include"
	}
	return store.ResourceInstance{}, &statusError{http.StatusNotFound, errors.New(message)}
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
			return "", &statusError{http.StatusNotFound, errors.New("lease " + leaseID + " not found among this session's leases")}
		}
		view := s.leases.ViewOf(ctx, lease)
		own, resourceID = &view, lease.ResourceID
	}
	if resourceID == "" {
		return "", &statusError{http.StatusBadRequest, errors.New("name resourceId or leaseId")}
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
		if action.Op == "select_window" && !supportsWindowScope(ticket.Instance) {
			return refuse(&statusError{http.StatusBadRequest, errors.New("only the macOS cua-driver backend supports select_window")})
		}
		if _, ok := ticket.Spec.Operation(action.Op); !ok {
			return refuse(&statusError{http.StatusBadRequest, fmt.Errorf("%s has no operation %q; it has %s", ticket.Instance.Name, action.Op, strings.Join(ticket.Spec.OperationNames(), ", "))})
		}
	}
	if raw, _ := json.Marshal(actions); len(raw) > ticket.Spec.MaxArgsBytes {
		return refuse(&statusError{http.StatusBadRequest, fmt.Errorf("the actions' arguments exceed %d KB; send files in pieces (put_files)", ticket.Spec.MaxArgsBytes>>10)})
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
		var reconnecting *resources.DeviceReconnectingError
		if errors.As(operateErr, &reconnecting) {
			return nil, &statusError{http.StatusConflict, reconnecting}
		}
		return nil, &statusError{http.StatusConflict, errors.New("device_error: " + operateErr.Error())}
	}
	if result.Error != "" {
		return nil, &statusError{http.StatusConflict, errors.New(cmpOr(result.ErrorCode, "backend_error") + ": " + result.Error)}
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
			return &statusError{http.StatusForbidden, errors.New("workspace " + workspaceID + " is not one this session may work in (Member)")}
		}
		workspace, err := s.store.GetWorkspace(ctx, workspaceID)
		if err != nil {
			return &statusError{http.StatusNotFound, errors.New("workspace " + workspaceID + " not found")}
		}
		if workspace.DeviceID != instance.Source.ID || strings.TrimSpace(workspace.LocalPath) == "" {
			return &statusError{http.StatusBadRequest, fmt.Errorf("workspace %s (%s) is not on %s; name a workspace on that device, or use a scratch folder", workspaceID, workspace.Name, instance.Source.Label)}
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
			return nil, &statusError{http.StatusBadRequest, errors.New("actions must be a list of {op, args}")}
		}
	}
	if op := mcpArgString(args, "op"); op != "" {
		action := store.ResourceAction{Op: op}
		if raw, ok := args["args"]; ok && len(raw) > 0 && string(raw) != "null" {
			if err := json.Unmarshal(raw, &action.Args); err != nil {
				return nil, &statusError{http.StatusBadRequest, errors.New("args must be an object")}
			}
		}
		actions = append([]store.ResourceAction{action}, actions...)
	}
	if len(actions) == 0 {
		return nil, &statusError{http.StatusBadRequest, errors.New("name an op (with its args) or actions")}
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
		return nil, &statusError{http.StatusBadRequest, fmt.Errorf("at most %d actions in one call", maxResourceActions)}
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
	if !actor.Agent() {
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
		return instance.Holder, resourceOperationNames(instance, spec)
	}
	return instance.Holder, nil
}

func supportsWindowScope(instance store.ResourceInstance) bool {
	return instance.Platform == "macos" &&
		slices.ContainsFunc(instance.Backends, func(backend store.ResourceBackend) bool {
			return backend.ID == "cua-driver" && backend.Mode == "remote_ops"
		})
}

func resourceOperationNames(instance store.ResourceInstance, spec resources.TypeSpec) []string {
	names := spec.OperationNames()
	if !supportsWindowScope(instance) {
		names = slices.DeleteFunc(names, func(name string) bool { return name == "select_window" })
	}
	return names
}
