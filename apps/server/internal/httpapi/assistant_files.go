package httpapi

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

// The files of the workspaces an assistant runs in (DEV-223): its home and
// each message channel's workspace, browsed and edited by the person in the
// Web. The tree and binary previews use the workspace file routes; these
// read a file for editing, save it over the version the person saw (its
// sha256), keep its versions, rename and delete it. Foundry's generated
// files are read-only here, and so is the managed block of the home's
// AGENTS.md: the person edits the rest, the instructions, which Foundry no
// longer rewrites. The assistant's own conversations may change the home
// too; channel sessions never change their workspace (DEV-203, sandboxed).

// maxAssistantFileWrite bounds a saved file (the Worker's write_file limit).
const maxAssistantFileWrite = 512 * 1024

// assistantInstructionsPath is the home's instructions file.
const assistantInstructionsPath = "AGENTS.md"

type wsManageFilePayload struct {
	WorkspaceID    string  `json:"workspaceId"`
	Op             string  `json:"op"`
	Path           string  `json:"path"`
	ToPath         string  `json:"toPath,omitempty"`
	ExpectedSha256 *string `json:"expectedSha256,omitempty"`
}

type wsFileManagedPayload struct {
	WorkspaceID string `json:"workspaceId"`
	Op          string `json:"op"`
	Path        string `json:"path"`
	ToPath      string `json:"toPath,omitempty"`
	Error       string `json:"error,omitempty"`
	Code        string `json:"code,omitempty"`
}

func (p wsFileManagedPayload) refusal() error {
	if p.Error == "" {
		return nil
	}
	switch p.Code {
	case "conflict", "exists":
		return &statusError{http.StatusConflict, errors.New(p.Error)}
	case "missing":
		return &statusError{http.StatusNotFound, errors.New(p.Error)}
	case "invalid_path":
		return &statusError{http.StatusBadRequest, errors.New(p.Error)}
	}
	return &statusError{http.StatusBadGateway, errors.New(p.Error)}
}

func (s *Server) workspaceFileStore() (store.WorkspaceFileStore, error) {
	st, ok := s.store.(store.WorkspaceFileStore)
	if !ok {
		return nil, errors.New("this server keeps no file versions")
	}
	return st, nil
}

// assistantWorkspaces are the workspaces the assistant runs in: its home,
// then each of its channels' workspaces.
func (s *Server) assistantWorkspaces(ctx context.Context, agent store.PersonalAgent) ([]store.AssistantWorkspace, error) {
	out := []store.AssistantWorkspace{}
	add := func(id string, kind store.AssistantWorkspaceKind, channel store.MessageChannelRecord) {
		workspace, err := s.store.GetWorkspace(ctx, id)
		if err != nil {
			return
		}
		view := store.AssistantWorkspace{ID: workspace.ID, Kind: kind, Name: workspace.Name, DeviceID: workspace.DeviceID,
			DeviceName: s.deviceLabel(ctx, workspace.DeviceID), Path: workspace.LocalPath, ChannelID: channel.ID, ChannelName: channel.Name}
		if connection := s.hub.connectionFor(workspace.DeviceID); connection != nil {
			view.Connected = true
			view.CanWrite = connection.hasCapability(store.DaemonCapabilityWorkspaceFileWrite)
			view.CanManage = connection.hasCapability(store.DaemonCapabilityWorkspaceFileManage)
		}
		out = append(out, view)
	}
	if agent.WorkspaceID != "" {
		add(agent.WorkspaceID, store.AssistantWorkspaceKindHome, store.MessageChannelRecord{})
	}
	if st, ok := s.store.(store.MessageChannelStore); ok {
		records, err := st.ListMessageChannels(ctx, agent.UserID, agent.ID)
		if err != nil {
			return nil, err
		}
		for _, record := range records {
			if record.WorkspaceID != "" && record.WorkspaceID != agent.WorkspaceID {
				add(record.WorkspaceID, store.AssistantWorkspaceKindChannel, record)
			}
		}
	}
	return out, nil
}

// assistantWorkspaceOf is the request's workspace when it is one of the
// assistant's (else 404).
func (s *Server) assistantWorkspaceOf(ctx context.Context, agent store.PersonalAgent, workspaceID string) (store.WorkspaceProjection, store.AssistantWorkspaceKind, error) {
	all, err := s.assistantWorkspaces(ctx, agent)
	if err != nil {
		return store.WorkspaceProjection{}, "", err
	}
	index := slices.IndexFunc(all, func(view store.AssistantWorkspace) bool { return view.ID == strings.TrimSpace(workspaceID) })
	if index < 0 {
		return store.WorkspaceProjection{}, "", &statusError{http.StatusNotFound, errors.New("not one of the assistant's workspaces")}
	}
	workspace, err := s.store.GetWorkspace(ctx, all[index].ID)
	return workspace, all[index].Kind, err
}

// generatedAssistantPath reports a home file Foundry rewrites before each
// run: everything under .foundry/ (its index, examples and skills) and the
// links to its skills in each runtime's skill folder.
func generatedAssistantPath(kind store.AssistantWorkspaceKind, path string) bool {
	if kind != store.AssistantWorkspaceKindHome {
		return false
	}
	if path == ".foundry" || strings.HasPrefix(path, ".foundry/") {
		return true
	}
	for _, root := range []string{".claude/skills/", ".agents/skills/"} {
		if name, ok := strings.CutPrefix(path, root); ok {
			name, _, _ = strings.Cut(name, "/")
			if slices.ContainsFunc(prompt.AssistantSkills(), func(skill prompt.AssistantSkill) bool { return skill.Name == name }) {
				return true
			}
		}
	}
	return false
}

func isHomeInstructions(kind store.AssistantWorkspaceKind, path string) bool {
	return kind == store.AssistantWorkspaceKindHome && path == assistantInstructionsPath
}

func missingFileError(err error) bool {
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "no such file") || strings.Contains(text, "not found") || strings.Contains(text, "enoent")
}

func newRevisionID() string {
	return "rev_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16]
}

// deviceFile is a file as its device has it now, for editing.
type deviceFile struct {
	content   string
	sha256    string
	missing   bool
	truncated bool
	binary    bool
	// realPath is where a link inside the workspace leads; empty otherwise.
	realPath string
	// foundrySkill: a file of a skill Foundry linked in from outside the
	// workspace, which is never changed here.
	foundrySkill bool
}

// generated reports a file Foundry rewrites, whether opened by its path or
// through a link to it.
func (f deviceFile) generated(kind store.AssistantWorkspaceKind, path string) bool {
	return generatedAssistantPath(kind, path) || (f.realPath != "" && generatedAssistantPath(kind, f.realPath))
}

func (s *Server) readDeviceFile(ctx context.Context, workspace store.WorkspaceProjection, path string) (deviceFile, error) {
	if s.hub.connectionFor(workspace.DeviceID) == nil {
		return deviceFile{}, &statusError{http.StatusConflict, errors.New("the workspace's device is not connected")}
	}
	ctx, cancel := context.WithTimeout(ctx, deviceFileRequestTimeout)
	defer cancel()
	read, err := s.hub.ReadWorkspaceFile(ctx, workspace, path)
	if err != nil {
		if missingFileError(err) {
			return deviceFile{missing: true}, nil
		}
		return deviceFile{}, deviceRequestError(workspace, err)
	}
	head := read.Content
	if len(head) > 8192 {
		head = head[:8192]
	}
	return deviceFile{content: read.Content, sha256: contentSha256(read.Content), truncated: read.Truncated,
		binary: strings.Contains(head, "\x00") || !utf8.ValidString(read.Content), realPath: read.RealPath, foundrySkill: read.ReadOnly}, nil
}

// assistantManagedBlock is the home AGENTS.md's managed block as Foundry
// writes it before the assistant's next conversation.
func (s *Server) assistantManagedBlock(ctx context.Context, agent store.PersonalAgent) (string, error) {
	if s.assistant == nil {
		return "", errors.New("the assistant is not available on this server")
	}
	input, err := s.assistant.PromptInput(ctx, agent, time.Now())
	if err != nil {
		return "", err
	}
	return prompt.ManagedBlock(input), nil
}

// assistantFile reads one file for the editor, with its versions.
func (s *Server) assistantFile(ctx context.Context, agent store.PersonalAgent, workspace store.WorkspaceProjection, kind store.AssistantWorkspaceKind, path string) (store.AssistantFile, error) {
	out := store.AssistantFile{WorkspaceID: workspace.ID, Path: path, Revisions: []store.WorkspaceFileRevision{}}
	st, err := s.workspaceFileStore()
	if err != nil {
		return out, err
	}
	file, err := s.readDeviceFile(ctx, workspace, path)
	if err != nil {
		return out, err
	}
	out.Content, out.Sha256, out.Missing, out.Bytes = file.content, file.sha256, file.missing, len(file.content)
	connection := s.hub.connectionFor(workspace.DeviceID)
	switch {
	case file.foundrySkill:
		out.ReadOnly = store.AssistantFileReadOnlyFoundrySkill
	case file.generated(kind, path):
		out.ReadOnly = store.AssistantFileReadOnlyGenerated
	case file.binary:
		out.ReadOnly, out.Content = store.AssistantFileReadOnlyBinary, ""
	case file.truncated:
		out.ReadOnly = store.AssistantFileReadOnlyTooLarge
	case connection == nil || !connection.hasCapability(store.DaemonCapabilityWorkspaceFileWrite):
		out.ReadOnly = store.AssistantFileReadOnlyWorker
	}
	if isHomeInstructions(kind, path) {
		block, err := s.assistantManagedBlock(ctx, agent)
		if err != nil {
			return out, err
		}
		present, instructions := prompt.SplitAgentsFile(file.content)
		if file.missing {
			instructions = prompt.DefaultInstructions()
		}
		out.Content = instructions
		view := &store.AssistantInstructions{ManagedBlock: block, ManagedPresent: present != "", MaxBytes: prompt.AgentsFileMaxBytes,
			Bytes: len(prompt.JoinAgentsFile(block, instructions)), DefaultContent: prompt.DefaultInstructions()}
		started, err := st.AssistantInstructionsDefault(ctx, agent.ID)
		switch {
		case errors.Is(err, store.ErrNotFound):
			err = st.SetAssistantInstructionsDefault(ctx, agent.ID, prompt.DefaultInstructionsSha256())
		case err == nil:
			view.NewDefault = started != prompt.DefaultInstructionsSha256() &&
				strings.TrimSpace(instructions) != strings.TrimSpace(prompt.DefaultInstructions())
		}
		if err != nil {
			return out, err
		}
		out.Instructions = view
		if out.ReadOnly == "" && !connection.hasCapability(store.DaemonCapabilityAssistantInstructionsBlock) {
			out.ReadOnly = store.AssistantFileReadOnlyWholeFile
		}
	}
	revisions, err := st.ListWorkspaceFileRevisions(ctx, workspace.ID, path, store.MaxWorkspaceFileRevisions)
	if err != nil {
		return out, err
	}
	shown := contentSha256(out.Content)
	for i := range revisions {
		revisions[i].Current = i == 0 && !out.Missing && revisions[i].Sha256 == shown
	}
	out.Revisions = revisions
	return out, nil
}

// saveAssistantFile writes content over the version the person saw (base),
// keeping what was there as a version when it was never saved, then the new
// one. For the home AGENTS.md content is the instructions, saved below the
// current managed block.
func (s *Server) saveAssistantFile(ctx context.Context, agent store.PersonalAgent, workspace store.WorkspaceProjection, kind store.AssistantWorkspaceKind, path, content, base, source string) error {
	if !store.RelativeFolderPath(path) {
		return &statusError{http.StatusBadRequest, errors.New("the path must be relative to the workspace")}
	}
	if generatedAssistantPath(kind, path) {
		return &statusError{http.StatusForbidden, errors.New("Foundry rewrites this file before each conversation; it can't be edited here")}
	}
	if len(content) > maxAssistantFileWrite || !utf8.ValidString(content) || strings.Contains(content, "\x00") {
		return &statusError{http.StatusBadRequest, errors.New("only UTF-8 text files of at most 512 KiB are saved here")}
	}
	st, err := s.workspaceFileStore()
	if err != nil {
		return err
	}
	current, err := s.readDeviceFile(ctx, workspace, path)
	if err != nil {
		return err
	}
	if current.foundrySkill {
		return &statusError{http.StatusForbidden, errors.New("this file belongs to a skill Foundry links in from outside the workspace; it can't be edited here")}
	}
	if current.generated(kind, path) {
		return &statusError{http.StatusForbidden, errors.New("Foundry rewrites this file before each conversation; it can't be edited here")}
	}
	if current.binary || current.truncated {
		return &statusError{http.StatusBadRequest, errors.New("this file is not edited here (binary or too large)")}
	}
	if current.sha256 != strings.ToLower(strings.TrimSpace(base)) {
		return &statusError{http.StatusConflict, errors.New("the file changed on the device since it was read")}
	}
	whole, before := content, current.content
	if isHomeInstructions(kind, path) {
		connection := s.hub.connectionFor(workspace.DeviceID)
		if connection == nil || !connection.hasCapability(store.DaemonCapabilityAssistantInstructionsBlock) {
			return &statusError{http.StatusConflict, errors.New("the assistant's computer runs a Worker that rewrites AGENTS.md whole; update it to edit the instructions")}
		}
		block, err := s.assistantManagedBlock(ctx, agent)
		if err != nil {
			return err
		}
		whole = prompt.JoinAgentsFile(block, content)
		if len(whole) > prompt.AgentsFileMaxBytes {
			return &statusError{http.StatusBadRequest, errors.New("AGENTS.md would be larger than 28 KiB with Foundry's block; Codex reads at most 32 KiB of instructions")}
		}
		_, before = prompt.SplitAgentsFile(current.content)
	}
	if !current.missing {
		if err := s.keepUnsavedVersion(ctx, st, workspace.ID, path, before); err != nil {
			return err
		}
	}
	expected := current.sha256
	if _, err := s.writeWorkspaceTextFile(ctx, workspace, path, whole, &expected); err != nil {
		return err
	}
	return addFileRevision(ctx, st, workspace.ID, path, content, source)
}

// keepUnsavedVersion saves the file as it is now when its newest version is
// another (changed on the device, or never saved), so it can be restored.
func (s *Server) keepUnsavedVersion(ctx context.Context, st store.WorkspaceFileStore, workspaceID, path, content string) error {
	revisions, err := st.ListWorkspaceFileRevisions(ctx, workspaceID, path, 1)
	if err != nil {
		return err
	}
	if len(revisions) > 0 && revisions[0].Sha256 == contentSha256(content) {
		return nil
	}
	source := "outside"
	if len(revisions) == 0 {
		source = "seed"
	}
	return addFileRevision(ctx, st, workspaceID, path, content, source)
}

func addFileRevision(ctx context.Context, st store.WorkspaceFileStore, workspaceID, path, content, source string) error {
	return st.AddWorkspaceFileRevision(ctx, workspaceID, path, store.WorkspaceFileRevision{
		ID: newRevisionID(), At: time.Now().UTC().Format(time.RFC3339Nano), Sha256: contentSha256(content), Bytes: len(content), Source: source,
	}, content)
}

// --- handlers ---

func (s *Server) handleListAssistantWorkspaces(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	workspaces, err := s.assistantWorkspaces(r.Context(), agent)
	writeResult(w, store.AssistantWorkspaceList{Workspaces: workspaces}, err)
}

// assistantFileRequest is the assistant and its workspace a request names.
func (s *Server) assistantFileRequest(w http.ResponseWriter, r *http.Request, workspaceID string) (store.PersonalAgent, store.WorkspaceProjection, store.AssistantWorkspaceKind, bool) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return agent, store.WorkspaceProjection{}, "", false
	}
	workspace, kind, err := s.assistantWorkspaceOf(r.Context(), agent, workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return agent, workspace, kind, false
	}
	return agent, workspace, kind, true
}

func (s *Server) handleReadAssistantFile(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	query := r.URL.Query()
	agent, workspace, kind, ok := s.assistantFileRequest(w, r, query.Get("workspaceId"))
	if !ok {
		return
	}
	path := strings.TrimSpace(query.Get("path"))
	if !store.RelativeFolderPath(path) {
		writeError(w, http.StatusBadRequest, "the path must be relative to the workspace")
		return
	}
	file, err := s.assistantFile(r.Context(), agent, workspace, kind, path)
	writeResult(w, file, err)
}

func (s *Server) handleWriteAssistantFile(w http.ResponseWriter, r *http.Request) {
	var input store.AssistantFileWrite
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	agent, workspace, kind, ok := s.assistantFileRequest(w, r, input.WorkspaceID)
	if !ok {
		return
	}
	path := strings.TrimSpace(input.Path)
	if err := s.saveAssistantFile(r.Context(), agent, workspace, kind, path, input.Content, input.BaseSha256, "web"); err != nil {
		writeResult(w, nil, err)
		return
	}
	file, err := s.assistantFile(r.Context(), agent, workspace, kind, path)
	writeResult(w, file, err)
}

func (s *Server) handleRevertAssistantFile(w http.ResponseWriter, r *http.Request) {
	var input store.AssistantFileRevert
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	agent, workspace, kind, ok := s.assistantFileRequest(w, r, input.WorkspaceID)
	if !ok {
		return
	}
	st, err := s.workspaceFileStore()
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	path := strings.TrimSpace(input.Path)
	_, content, err := st.GetWorkspaceFileRevision(r.Context(), workspace.ID, path, input.RevisionID)
	if err == nil {
		err = s.saveAssistantFile(r.Context(), agent, workspace, kind, path, content, input.BaseSha256, "revert")
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	file, err := s.assistantFile(r.Context(), agent, workspace, kind, path)
	writeResult(w, file, err)
}

// handleMoveAssistantFile renames a file (toPath) or deletes it; a deleted
// file's content stays among its versions.
func (s *Server) handleMoveAssistantFile(w http.ResponseWriter, r *http.Request) {
	var input store.AssistantFileMove
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	_, workspace, kind, ok := s.assistantFileRequest(w, r, input.WorkspaceID)
	if !ok {
		return
	}
	ctx := r.Context()
	path, to := strings.TrimSpace(input.Path), strings.TrimSpace(input.ToPath)
	switch {
	case !store.RelativeFolderPath(path) || (to != "" && !store.RelativeFolderPath(to)):
		writeError(w, http.StatusBadRequest, "the path must be relative to the workspace")
		return
	case generatedAssistantPath(kind, path) || generatedAssistantPath(kind, to):
		writeError(w, http.StatusForbidden, "Foundry rewrites this file before each conversation; it can't be changed here")
		return
	case isHomeInstructions(kind, path) || isHomeInstructions(kind, to):
		writeError(w, http.StatusForbidden, "AGENTS.md holds the assistant's instructions; edit it instead")
		return
	}
	connection := s.hub.connectionFor(workspace.DeviceID)
	if connection == nil {
		writeError(w, http.StatusConflict, "the workspace's device is not connected")
		return
	}
	if !connection.hasCapability(store.DaemonCapabilityWorkspaceFileManage) {
		writeError(w, http.StatusConflict, "the workspace's device runs a Worker too old to rename or delete files; update it")
		return
	}
	st, err := s.workspaceFileStore()
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	current, err := s.readDeviceFile(ctx, workspace, path)
	if err == nil && current.missing {
		err = &statusError{http.StatusNotFound, errors.New("the file does not exist")}
	}
	if err == nil && (current.foundrySkill || current.generated(kind, path)) {
		err = &statusError{http.StatusForbidden, errors.New("Foundry manages this file; it can't be changed here")}
	}
	if err == nil && current.sha256 != strings.ToLower(strings.TrimSpace(input.BaseSha256)) {
		err = &statusError{http.StatusConflict, errors.New("the file changed on the device since it was read")}
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	op := "delete"
	if to != "" {
		op = "rename"
	}
	textual := !current.binary && !current.truncated
	if op == "delete" && textual {
		if err := addFileRevision(ctx, st, workspace.ID, path, current.content, "deleted"); err != nil {
			writeResult(w, nil, err)
			return
		}
	}
	expected := current.sha256
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if _, err := callDevice[wsFileManagedPayload](callCtx, connection, wsManageFileType,
		wsManageFilePayload{WorkspaceID: workspace.ID, Op: op, Path: path, ToPath: to, ExpectedSha256: &expected}); err != nil {
		writeResult(w, nil, err)
		return
	}
	if op == "rename" {
		if err := st.MoveWorkspaceFileRevisions(ctx, workspace.ID, path, to); err != nil {
			writeResult(w, nil, err)
			return
		}
	}
	writeResult(w, map[string]string{"workspaceId": workspace.ID, "path": path, "toPath": to, "op": op}, nil)
}

// handleAssistantInstructionsDefault takes Foundry's current default
// instructions into the home AGENTS.md (adopt), or keeps the person's and
// stops offering this default.
func (s *Server) handleAssistantInstructionsDefault(w http.ResponseWriter, r *http.Request) {
	var input store.AssistantInstructionsDefault
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	workspace, kind, err := s.assistantWorkspaceOf(ctx, agent, agent.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	st, err := s.workspaceFileStore()
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if input.Adopt {
		err = s.saveAssistantFile(ctx, agent, workspace, kind, assistantInstructionsPath, prompt.DefaultInstructions(), input.BaseSha256, "default")
	}
	if err == nil {
		err = st.SetAssistantInstructionsDefault(ctx, agent.ID, prompt.DefaultInstructionsSha256())
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	file, err := s.assistantFile(ctx, agent, workspace, kind, assistantInstructionsPath)
	writeResult(w, file, err)
}
