package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Workspace lifecycle (docs/personal-agent.md §4): creating, renaming,
// choosing skills and connectors, archiving and restoring a workspace. The
// REST handlers and the Personal Agent's MCP tools call these, so each rule
// is written once. Callers authorize first (the route's rule, or paScope
// plus the assistant's policy); these check what holds for every caller.

// WorkspaceActor is who performs a lifecycle write.
type WorkspaceActor struct {
	// UserID is the account the write is done as.
	UserID string
	// SessionID is the assistant session whose tool call this is; empty for
	// a person's own request.
	SessionID string
	// Auditor, when set, is told of every write, refused and failed ones
	// included (the Personal Agent's pa_actions).
	Auditor WorkspaceLifecycleAuditor
}

// WorkspaceLifecycleAuditor records lifecycle writes.
type WorkspaceLifecycleAuditor interface {
	AuditWorkspaceLifecycle(ctx context.Context, record WorkspaceLifecycleRecord)
}

// Lifecycle operations, WorkspaceLifecycleRecord.Operation. They are the
// Personal Agent's policy keys where one exists.
const (
	WorkspaceOpCreate         = store.PersonalAgentActionCreateWorkspace
	WorkspaceOpRegisterFolder = store.PersonalAgentActionRegisterFolder
	WorkspaceOpRename         = store.PersonalAgentActionRenameWorkspace
	WorkspaceOpSetSkills      = "set_skills"
	WorkspaceOpSetConnectors  = "set_connectors"
	WorkspaceOpArchive        = store.PersonalAgentActionArchive
	WorkspaceOpRestore        = store.PersonalAgentActionRestore
)

// WorkspaceLifecycleRecord is one lifecycle write as audited.
type WorkspaceLifecycleRecord struct {
	Operation   string
	WorkspaceID string
	UserID      string
	SessionID   string
	// Summary says what changed, for people ("renamed to “Blog”").
	Summary string
	// Err is why the write failed or was refused; nil when it was applied.
	Err error
}

// WorkspaceCreateRequest creates or registers a workspace on a device.
type WorkspaceCreateRequest struct {
	DeviceID string
	// Path is the folder. With Create it may be empty: the folder is then
	// FolderName (or Name made into one) under the device's first managed
	// root. Without Create it names an existing folder.
	Path string
	// Create makes the folder first; it must lie inside the device's
	// managed roots, not exist yet, and the device must declare
	// store.DaemonCapabilityWorkspaceCreate.
	Create *WorkspaceCreateSource
	// FolderName is the new folder's name when Path is empty.
	FolderName string
	// Name is the display name; empty keeps the folder's.
	Name string
	// Purpose is one sentence on what the workspace is for (see
	// RenameWorkspace).
	Purpose string
	// Kind is store.WorkspaceKindProject (empty) or
	// store.WorkspaceKindPersonalAgent; only the Personal Agent's setup
	// passes the latter.
	Kind string
}

// WorkspaceCreateSource is how a new folder starts: Kind "empty" (GitInit
// to run git init, Files written into it) or "clone" of URL.
type WorkspaceCreateSource struct {
	Kind    string
	URL     string
	GitInit bool
	Files   []WorkspaceFile
}

// WorkspaceFile is a file a new empty folder starts with; Path is relative
// to the folder, "/"-separated.
type WorkspaceFile struct {
	Path    string
	Content string
}

// Kinds of WorkspaceCreateSource.
const (
	WorkspaceCreateEmpty = "empty"
	WorkspaceCreateClone = "clone"
)

// WorkspaceDetails changes a workspace's display name and purpose; a nil
// field is left as it is.
type WorkspaceDetails struct {
	Name    *string
	Purpose *string
}

// workspaceSetupTimeout is how long creating or registering a folder waits
// for its device.
const workspaceSetupTimeout = 60 * time.Second

// maxWorkspacePurpose is the longest purpose, in characters.
const maxWorkspacePurpose = 600

// CreateWorkspace creates (request.Create) or registers a folder on
// request.DeviceID as a workspace, then names it and sets its kind and
// purpose. The caller has checked actor may use the device. Refusals are
// statusErrors: 400 for an invalid request or a path outside the managed
// roots, 409 for a device not connected, without workspace_create, or a
// folder another device's workspace holds, 504 when the device did not
// answer within a minute.
func (s *Server) CreateWorkspace(ctx context.Context, actor WorkspaceActor, request WorkspaceCreateRequest) (store.WorkspaceProjection, error) {
	operation := WorkspaceOpRegisterFolder
	if request.Create != nil {
		operation = WorkspaceOpCreate
	}
	workspace, path, err := s.createWorkspace(ctx, request)
	s.auditWorkspaceLifecycle(ctx, actor, WorkspaceLifecycleRecord{
		Operation: operation, WorkspaceID: workspace.ID, Err: err,
		Summary: fmt.Sprintf("%s %s on device %s", operation, path, strings.TrimSpace(request.DeviceID)),
	})
	return workspace, err
}

func (s *Server) createWorkspace(ctx context.Context, request WorkspaceCreateRequest) (store.WorkspaceProjection, string, error) {
	deviceID := strings.TrimSpace(request.DeviceID)
	path := strings.TrimSpace(request.Path)
	name := strings.TrimSpace(request.Name)
	if deviceID == "" {
		return store.WorkspaceProjection{}, path, badRequest("deviceId is required")
	}
	if name != "" {
		if err := validateWorkspaceName(name); err != nil {
			return store.WorkspaceProjection{}, path, err
		}
	}
	if err := validateWorkspacePurpose(request.Purpose); err != nil {
		return store.WorkspaceProjection{}, path, err
	}
	kind := cmpOr(request.Kind, store.WorkspaceKindProject)
	if kind != store.WorkspaceKindProject && kind != store.WorkspaceKindPersonalAgent {
		return store.WorkspaceProjection{}, path, badRequest("unknown workspace kind " + kind)
	}
	// The assistant's workspace is always a new folder: registering an
	// existing one would turn a project, and its sharing, into it.
	if kind == store.WorkspaceKindPersonalAgent && request.Create == nil {
		return store.WorkspaceProjection{}, path, badRequest("the assistant's workspace must be a new folder")
	}
	payload := wsSetupWorkspacePayload{Path: path}
	if request.Create == nil {
		if path == "" {
			return store.WorkspaceProjection{}, path, badRequest("path is required")
		}
	} else {
		create, err := setupWorkspaceCreate(*request.Create)
		if err != nil {
			return store.WorkspaceProjection{}, path, err
		}
		connection := s.hub.connectionFor(deviceID)
		if connection == nil {
			return store.WorkspaceProjection{}, path, &statusError{http.StatusConflict, ErrLocalDaemonNotConnected}
		}
		if !connection.hasCapability(store.DaemonCapabilityWorkspaceCreate) {
			return store.WorkspaceProjection{}, path, &statusError{http.StatusConflict, errors.New("this device's Foundry cannot create folders yet: update it first")}
		}
		_, registration := connection.registrationSnapshot()
		if payload.Path, err = managedWorkspacePath(registration.Device.ManagedRoots, path, cmpOr(strings.TrimSpace(request.FolderName), name)); err != nil {
			return store.WorkspaceProjection{}, path, err
		}
		path = payload.Path
		payload.Create = &create
	}
	setupCtx, cancel := context.WithTimeout(ctx, workspaceSetupTimeout)
	defer cancel()
	workspace, err := s.setupWorkspace(setupCtx, deviceID, payload)
	if err != nil {
		return store.WorkspaceProjection{}, path, err
	}
	changed := false
	if kind != store.WorkspaceKindProject {
		if err := s.store.SetWorkspaceKind(ctx, workspace.ID, kind); err != nil {
			return workspace, path, err
		}
		changed = true
	}
	if purpose := strings.TrimSpace(request.Purpose); purpose != "" {
		if err := s.store.SetWorkspacePurpose(ctx, workspace.ID, purpose); err != nil {
			return workspace, path, err
		}
	}
	if name != "" && name != workspace.Name {
		if _, err := s.store.RenameWorkspace(ctx, workspace.ID, name); err != nil {
			return workspace, path, err
		}
		changed = true
	}
	if !changed {
		return workspace, path, nil
	}
	s.projectionsChanged("", fieldWorkspaces, fieldPromotedSkills)
	workspace, err = s.store.GetWorkspace(ctx, workspace.ID)
	return workspace, path, err
}

// setupWorkspace has the device set the folder up and registers it.
func (s *Server) setupWorkspace(ctx context.Context, deviceID string, payload wsSetupWorkspacePayload) (store.WorkspaceProjection, error) {
	connection := s.hub.connectionFor(deviceID)
	var workspace store.WorkspaceProjection
	err := store.ErrNotFound
	if connection != nil {
		workspace, err = connection.setupWorkspace(ctx, payload)
	}
	switch {
	case errors.Is(err, store.ErrNotFound):
		return workspace, &statusError{http.StatusConflict, ErrLocalDaemonNotConnected}
	case errors.Is(err, store.ErrWorkspaceOwnedByAnotherDevice):
		return workspace, &statusError{http.StatusConflict, errors.New("This folder is already a workspace of another device. Open it there, or remove it from that device first.")}
	// The device keeps working after the wait ends, and a late answer still
	// registers the folder.
	case errors.Is(err, context.DeadlineExceeded):
		return workspace, &statusError{http.StatusGatewayTimeout, errors.New("The device did not finish setting up this folder within 60 seconds. It may still be working on it (a large folder takes longer the first time): check the device's Workspaces in a minute before trying again.")}
	}
	return workspace, err
}

// setupWorkspaceCreate checks a new folder's source.
func setupWorkspaceCreate(source WorkspaceCreateSource) (wsSetupWorkspaceCreate, error) {
	switch source.Kind {
	case WorkspaceCreateEmpty:
		create := wsSetupWorkspaceCreate{Kind: source.Kind, GitInit: source.GitInit}
		for _, file := range source.Files {
			if !relativeFolderPath(file.Path) {
				return wsSetupWorkspaceCreate{}, badRequest("a new folder's file needs a relative path inside it: " + file.Path)
			}
			create.Files = append(create.Files, wsSetupWorkspaceFile{Path: file.Path, Content: file.Content})
		}
		return create, nil
	case WorkspaceCreateClone:
		if len(source.Files) > 0 {
			return wsSetupWorkspaceCreate{}, badRequest("a clone starts with the repository's files only")
		}
		url := strings.TrimSpace(source.URL)
		if url == "" || strings.HasPrefix(url, "-") || strings.ContainsFunc(url, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) {
			return wsSetupWorkspaceCreate{}, badRequest("a clone needs a repository URL")
		}
		return wsSetupWorkspaceCreate{Kind: source.Kind, URL: url}, nil
	}
	return wsSetupWorkspaceCreate{}, badRequest(`a new folder is "empty" or "clone"`)
}

// relativeFolderPath reports whether path names a file inside a folder:
// relative, "/"-separated, without "." or ".." steps or NUL. The device
// checks the resolved path again.
func relativeFolderPath(path string) bool {
	if path == "" || strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\\\x00") {
		return false
	}
	for _, step := range strings.Split(path, "/") {
		if step == "" || step == "." || step == ".." {
			return false
		}
	}
	return true
}

// managedWorkspacePath is where a new folder goes: path, which must lie
// inside one of the device's managed roots, or folderName under the first.
// It is a check by name only; the device checks the resolved path again.
func managedWorkspacePath(roots []string, path string, folderName string) (string, error) {
	if len(roots) == 0 {
		return "", &statusError{http.StatusConflict, errors.New("this device reports no folders new projects may be created in")}
	}
	if path == "" {
		folder := workspaceFolderName(folderName)
		if folder == "" {
			return "", badRequest("a new folder needs a path, a folder name or a name")
		}
		root := roots[0]
		return strings.TrimRight(root, devicePathSeparators) + devicePathSeparator(root) + folder, nil
	}
	for _, root := range roots {
		if insideDeviceRoot(root, path) {
			return path, nil
		}
	}
	return "", badRequest("new folders can only be created inside " + strings.Join(roots, ", "))
}

const devicePathSeparators = `/\`

// devicePathSeparator is the separator a device's absolute path uses.
func devicePathSeparator(root string) string {
	if !strings.Contains(root, "/") && strings.Contains(root, `\`) {
		return `\`
	}
	return "/"
}

// insideDeviceRoot reports whether path names a folder strictly inside
// root, without any "." or ".." step.
func insideDeviceRoot(root string, path string) bool {
	prefix := strings.TrimRight(root, devicePathSeparators) + devicePathSeparator(root)
	rest, ok := strings.CutPrefix(path, prefix)
	if !ok {
		return false
	}
	steps := strings.FieldsFunc(rest, func(r rune) bool { return strings.ContainsRune(devicePathSeparators, r) })
	return len(steps) > 0 && !slices.Contains(steps, ".") && !slices.Contains(steps, "..")
}

// workspaceFolderName makes a folder name of a display name: letters and
// digits of any script, other runs as one "-", ASCII lowercased, at most
// 64 characters.
func workspaceFolderName(name string) string {
	var folder strings.Builder
	dash := false
	for _, r := range strings.TrimSpace(name) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			if dash && folder.Len() > 0 {
				folder.WriteByte('-')
			}
			dash = false
			if r < unicode.MaxASCII {
				r = unicode.ToLower(r)
			}
			folder.WriteRune(r)
		default:
			dash = true
		}
	}
	runes := []rune(folder.String())
	if len(runes) > 64 {
		runes = runes[:64]
	}
	return strings.Trim(string(runes), "-")
}

// UpdateWorkspaceDetails renames a workspace (1–120 characters on one line)
// and sets its purpose (at most 600 characters).
func (s *Server) UpdateWorkspaceDetails(ctx context.Context, actor WorkspaceActor, workspaceID string, details WorkspaceDetails) (store.WorkspaceProjection, error) {
	var changes []string
	if details.Name != nil {
		changes = append(changes, fmt.Sprintf("name %q", strings.TrimSpace(*details.Name)))
	}
	if details.Purpose != nil {
		changes = append(changes, fmt.Sprintf("purpose %q", strings.TrimSpace(*details.Purpose)))
	}
	workspace, err := s.updateWorkspaceDetails(ctx, workspaceID, details)
	s.auditWorkspaceLifecycle(ctx, actor, WorkspaceLifecycleRecord{
		Operation: WorkspaceOpRename, WorkspaceID: workspaceID, Err: err,
		Summary: "set " + strings.Join(changes, " and "),
	})
	return workspace, err
}

func (s *Server) updateWorkspaceDetails(ctx context.Context, workspaceID string, details WorkspaceDetails) (store.WorkspaceProjection, error) {
	if details.Name == nil && details.Purpose == nil {
		details.Name = new(string)
	}
	if details.Name != nil {
		if err := validateWorkspaceName(strings.TrimSpace(*details.Name)); err != nil {
			return store.WorkspaceProjection{}, err
		}
	}
	if details.Purpose != nil {
		if err := validateWorkspacePurpose(*details.Purpose); err != nil {
			return store.WorkspaceProjection{}, err
		}
	}
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return store.WorkspaceProjection{}, err
	}
	if details.Purpose != nil {
		if err := s.store.SetWorkspacePurpose(ctx, workspaceID, *details.Purpose); err != nil {
			return store.WorkspaceProjection{}, err
		}
	}
	if details.Name == nil {
		return workspace, nil
	}
	workspace, err = s.store.RenameWorkspace(ctx, workspaceID, strings.TrimSpace(*details.Name))
	if err == nil {
		// The workspace list every view shows changed, and the catalog's
		// list of the workspaces using each skill.
		s.projectionsChanged("", fieldWorkspaces, fieldPromotedSkills)
	}
	return workspace, err
}

func validateWorkspaceName(name string) error {
	if name == "" || len([]rune(name)) > 120 || strings.ContainsAny(name, "\r\n\t") {
		return badRequest("display name must be 1–120 characters on one line")
	}
	return nil
}

func validateWorkspacePurpose(purpose string) error {
	if len([]rune(strings.TrimSpace(purpose))) > maxWorkspacePurpose {
		return badRequest(fmt.Sprintf("purpose must be at most %d characters", maxWorkspacePurpose))
	}
	return nil
}

// SetWorkspaceSkills replaces the skills selected in the workspace (and,
// when sent, those it turns off) and returns its bindings.
func (s *Server) SetWorkspaceSkills(ctx context.Context, actor WorkspaceActor, input store.SetWorkspaceSkillsInput) ([]store.WorkspaceSkillBinding, error) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	bindings, err := s.setWorkspaceSkills(ctx, input)
	s.auditWorkspaceLifecycle(ctx, actor, WorkspaceLifecycleRecord{
		Operation: WorkspaceOpSetSkills, WorkspaceID: input.WorkspaceID, Err: err,
		Summary: "selected skills " + strings.Join(input.SkillIDs, ", "),
	})
	return bindings, err
}

func (s *Server) setWorkspaceSkills(ctx context.Context, input store.SetWorkspaceSkillsInput) ([]store.WorkspaceSkillBinding, error) {
	if input.WorkspaceID == "" {
		return nil, badRequest("workspaceId is required")
	}
	if err := s.store.SetWorkspaceSkills(ctx, input); err != nil {
		return nil, err
	}
	s.projectionsChanged(input.WorkspaceID, workspaceSkillFields...)
	// Every view's catalog lists the workspaces using each skill.
	s.projectionsChanged("", fieldPromotedSkills)
	return s.store.ListWorkspaceSkillBindings(ctx, input.WorkspaceID)
}

// ChangeWorkspaceSkills adds and removes selected skills, keeping the
// others and their pins.
func (s *Server) ChangeWorkspaceSkills(ctx context.Context, actor WorkspaceActor, workspaceID string, add, remove []string) ([]store.WorkspaceSkillBinding, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	bindings, err := s.store.ListWorkspaceSkillBindings(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	selected := make([]string, 0, len(bindings)+len(add))
	for _, binding := range bindings {
		selected = append(selected, binding.SkillID)
	}
	return s.SetWorkspaceSkills(ctx, actor, store.SetWorkspaceSkillsInput{
		WorkspaceID: workspaceID, SkillIDs: changedSet(selected, add, remove),
	})
}

// SetWorkspaceConnectors replaces the connector accounts actor bound to the
// workspace with accountIDs (actor's own accounts only) and returns the
// workspace's connectors as actor sees them.
func (s *Server) SetWorkspaceConnectors(ctx context.Context, actor WorkspaceActor, workspaceID string, accountIDs []string) (store.WorkspaceExternalAccounts, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	view, err := s.setWorkspaceConnectors(ctx, actor.UserID, workspaceID, accountIDs)
	s.auditWorkspaceLifecycle(ctx, actor, WorkspaceLifecycleRecord{
		Operation: WorkspaceOpSetConnectors, WorkspaceID: workspaceID, Err: err,
		Summary: "bound connector accounts " + strings.Join(accountIDs, ", "),
	})
	return view, err
}

func (s *Server) setWorkspaceConnectors(ctx context.Context, userID string, workspaceID string, accountIDs []string) (store.WorkspaceExternalAccounts, error) {
	before, err := s.store.ListWorkspaceExternalAccounts(ctx, workspaceID)
	if err != nil {
		return store.WorkspaceExternalAccounts{}, err
	}
	if err := s.store.SetWorkspaceExternalAccounts(ctx, workspaceID, userID, accountIDs); err != nil {
		if errors.Is(err, store.ErrExternalAccountNotFound) {
			return store.WorkspaceExternalAccounts{}, &statusError{http.StatusNotFound, err}
		}
		return store.WorkspaceExternalAccounts{}, err
	}
	wanted := map[string]bool{}
	for _, id := range accountIDs {
		wanted[id] = true
	}
	had := map[string]bool{}
	for _, binding := range before {
		had[binding.AccountID] = true
		if !wanted[binding.AccountID] && binding.GrantedBy == userID {
			s.recordConnectorBinding(ctx, binding.AccountID, "unbound", workspaceID, userID)
		}
	}
	for id := range wanted {
		if !had[id] {
			s.recordConnectorBinding(ctx, id, "bound", workspaceID, userID)
		}
	}
	return s.workspaceExternalAccounts(ctx, workspaceID, userID)
}

// recordConnectorBinding adds a binding change to the account's audit trail.
func (s *Server) recordConnectorBinding(ctx context.Context, accountID, kind, workspaceID, userID string) {
	if err := s.store.AppendExternalAccountEvent(ctx, store.ExternalAccountEvent{AccountID: accountID, Kind: kind, Detail: workspaceID, ActorID: userID}); err != nil {
		s.connectors.ServerHeld.Logf("external account binding audit in %s: %v", workspaceID, err)
	}
}

// ChangeWorkspaceConnectors binds (add) and unbinds (remove) actor's
// connector accounts, keeping actor's other bindings.
func (s *Server) ChangeWorkspaceConnectors(ctx context.Context, actor WorkspaceActor, workspaceID string, add, remove []string) (store.WorkspaceExternalAccounts, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	bindings, err := s.store.ListWorkspaceExternalAccounts(ctx, workspaceID)
	if err != nil {
		return store.WorkspaceExternalAccounts{}, err
	}
	var own []string
	for _, binding := range bindings {
		if binding.GrantedBy == actor.UserID {
			own = append(own, binding.AccountID)
		}
	}
	return s.SetWorkspaceConnectors(ctx, actor, workspaceID, changedSet(own, add, remove))
}

// changedSet is current with add appended and remove taken out, each id
// once, in order.
func changedSet(current, add, remove []string) []string {
	result := []string{}
	for _, id := range append(slices.Clone(current), add...) {
		id = strings.TrimSpace(id)
		if id != "" && !slices.Contains(result, id) && !slices.Contains(remove, id) {
			result = append(result, id)
		}
	}
	return result
}

// ArchiveWorkspace archives a workspace: it starts no new sessions and
// nothing is deleted. The Personal Agent's own workspace cannot be
// archived. Archiving an archived workspace changes nothing.
func (s *Server) ArchiveWorkspace(ctx context.Context, actor WorkspaceActor, workspaceID string) (store.WorkspaceProjection, error) {
	workspace, err := s.setWorkspaceArchived(ctx, workspaceID, true)
	s.auditWorkspaceLifecycle(ctx, actor, WorkspaceLifecycleRecord{Operation: WorkspaceOpArchive, WorkspaceID: workspaceID, Summary: "archived", Err: err})
	return workspace, err
}

// RestoreWorkspace makes an archived workspace usable again.
func (s *Server) RestoreWorkspace(ctx context.Context, actor WorkspaceActor, workspaceID string) (store.WorkspaceProjection, error) {
	workspace, err := s.setWorkspaceArchived(ctx, workspaceID, false)
	s.auditWorkspaceLifecycle(ctx, actor, WorkspaceLifecycleRecord{Operation: WorkspaceOpRestore, WorkspaceID: workspaceID, Summary: "restored", Err: err})
	return workspace, err
}

func (s *Server) setWorkspaceArchived(ctx context.Context, workspaceID string, archived bool) (store.WorkspaceProjection, error) {
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return store.WorkspaceProjection{}, err
	}
	var at time.Time
	if archived {
		if workspace.Kind == store.WorkspaceKindPersonalAgent {
			return store.WorkspaceProjection{}, &statusError{http.StatusForbidden, errPersonalAgentWorkspaceKept}
		}
		at = time.Now().UTC()
	}
	if workspace, err = s.store.SetWorkspaceArchived(ctx, workspaceID, at); err != nil {
		return store.WorkspaceProjection{}, err
	}
	s.projectionsChanged("", fieldWorkspaces)
	return workspace, nil
}

// errPersonalAgentWorkspaceKept refuses removing or archiving the
// assistant's workspace.
var errPersonalAgentWorkspaceKept = errors.New("this is the assistant's own workspace: it cannot be removed or archived; stop the assistant in its settings instead")

// errPersonalAgentWorkspacePrivate refuses sharing the assistant's
// workspace.
var errPersonalAgentWorkspacePrivate = errors.New("this is the assistant's own workspace: it belongs to its owner alone and cannot have members")

// refuseRemovingWorkspace is the refusal of deleting the workspace, or nil.
func (s *Server) refuseRemovingWorkspace(ctx context.Context, workspaceID string) error {
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return err
	}
	if workspace.Kind == store.WorkspaceKindPersonalAgent {
		return &statusError{http.StatusForbidden, errPersonalAgentWorkspaceKept}
	}
	return nil
}

// refuseWorkspaceMembers is the refusal of giving the workspace a member,
// or nil.
func (s *Server) refuseWorkspaceMembers(ctx context.Context, workspaceID string) error {
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return err
	}
	if workspace.Kind == store.WorkspaceKindPersonalAgent {
		return &statusError{http.StatusForbidden, errPersonalAgentWorkspacePrivate}
	}
	return nil
}

// archivedWorkspace returns the refusal of a new session in an archived
// workspace, or nil. A workspace that cannot be read is left to the
// caller's own checks.
func archivedWorkspace(ctx context.Context, db store.Store, workspaceID string) error {
	if workspaceID == "" {
		return nil
	}
	workspace, err := db.GetWorkspace(ctx, workspaceID)
	if err != nil || workspace.ArchivedAt == "" {
		return nil
	}
	return &statusError{http.StatusConflict, fmt.Errorf("%s is archived: restore it on the Workspaces page before starting work there", cmpOr(workspace.Name, "This workspace"))}
}

// auditWorkspaceLifecycle logs a lifecycle write and tells actor's auditor.
func (s *Server) auditWorkspaceLifecycle(ctx context.Context, actor WorkspaceActor, record WorkspaceLifecycleRecord) {
	record.UserID, record.SessionID = actor.UserID, actor.SessionID
	outcome := "applied"
	if record.Err != nil {
		outcome = "failed: " + record.Err.Error()
	}
	log.Printf("workspace lifecycle %s workspace=%s user=%s session=%s: %s (%s)",
		record.Operation, record.WorkspaceID, record.UserID, record.SessionID, record.Summary, outcome)
	if actor.Auditor != nil {
		actor.Auditor.AuditWorkspaceLifecycle(ctx, record)
	}
}

func badRequest(message string) error {
	return &statusError{http.StatusBadRequest, errors.New(message)}
}
