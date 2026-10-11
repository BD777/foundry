package httpapi

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textdiff"
)

// What a session produced, as read_context reads it (scopes changes, file
// and background): the files its own tools wrote and its answers named, from
// the file ledger its worker reports as sessionFile events; one file's diff
// and current content, read from the session's device; and the commands it
// left running in the background, with their output. The reach is the
// web's: any reader of the session sees what its tools wrote and the files
// inside its workspace, while a file outside it that only an answer named,
// and background output (its commands can carry anything), need Member.

const diffContextLines = 3

func (s *Server) sessionOutputsForMCP(ctx context.Context, actor Actor, scope string, args map[string]json.RawMessage) (string, error) {
	id := mcpSessionID(args, "sessionId")
	target, err := s.resolveInspectTarget(ctx, actor, id, true)
	if err != nil {
		return "", err
	}
	if target.session == nil {
		return "", &mcpToolError{http.StatusBadRequest, id + " is a native chat: Foundry records no files or background work of its own for it; read it with scope=events or transcript"}
	}
	session := *target.session
	path := mcpArgString(args, "path")
	maxBytes := mcpArgNumber(args, "maxBytes", inspectDefaultBytes)
	switch scope {
	case "changes":
		if path == "" {
			return sessionFileList(session), nil
		}
		return s.sessionFileDiffForMCP(ctx, actor, session, path, mcpArgString(args, "inputId"), maxBytes)
	case "file":
		if path == "" {
			return "", &mcpToolError{http.StatusBadRequest, "scope=file needs path: one of the files scope=changes lists"}
		}
		return s.sessionFileForMCP(ctx, actor, session, path, maxBytes)
	default:
		if taskID := mcpArgString(args, "taskId"); taskID != "" {
			return s.backgroundOutputForMCP(ctx, actor, session, taskID, maxBytes)
		}
		return sessionBackgroundList(session), nil
	}
}

// mcpSessionFile is one file of a session, merged over its turns as the
// web's context panel shows it.
type mcpSessionFile struct {
	Path          string `json:"path"`
	WorkspacePath string `json:"workspacePath,omitempty"`
	// Change: created, modified, deleted, or referenced (an answer only
	// named it).
	Change  string   `json:"change"`
	Added   *int     `json:"added,omitempty"`
	Removed *int     `json:"removed,omitempty"`
	InGit   bool     `json:"inGit,omitempty"`
	Turns   []string `json:"turns"`
}

func sessionFileList(session store.AgentSession) string {
	files := []mcpSessionFile{}
	index := map[string]int{}
	for _, event := range session.Events {
		if event.Metadata == nil || event.Metadata.SessionFile == nil || event.Metadata.SessionFile.Path == "" {
			continue
		}
		record := event.Metadata.SessionFile
		turn := cmp.Or(record.InputID, session.ID)
		at, known := index[record.Path]
		if !known {
			index[record.Path] = len(files)
			files = append(files, mcpSessionFile{Path: record.Path, WorkspacePath: record.WorkspacePath, Change: record.Op, Turns: []string{}})
			at = len(files) - 1
		}
		file := &files[at]
		file.Change = mergedFileChange(file.Change, record.Op)
		file.InGit = record.InGitRepo
		file.WorkspacePath = cmp.Or(record.WorkspacePath, file.WorkspacePath)
		if record.TotalAdded != nil && record.TotalRemoved != nil {
			file.Added, file.Removed = record.TotalAdded, record.TotalRemoved
		} else if record.Added != nil && record.Removed != nil && record.InputID == "" {
			file.Added, file.Removed = record.Added, record.Removed
		}
		if !slices.Contains(file.Turns, turn) {
			file.Turns = append(file.Turns, turn)
		}
	}
	slices.SortFunc(files, func(a, b mcpSessionFile) int { return strings.Compare(a.Path, b.Path) })
	more := "path=<a path above> reads its diff (inputId=<a turn> for one turn's); scope=file reads its content."
	if len(files) == 0 {
		more = "Its tools wrote no files and its answers named none, or its worker did not record them."
	}
	hint, _ := json.Marshal(more)
	return "{\n  \"files\": " + encodeLines(files) + ",\n  \"more\": " + string(hint) + "\n}"
}

// mergedFileChange: a referenced file stays what the tools made it, a
// deletion is final, and a file created in the session stays created.
func mergedFileChange(earlier, later string) string {
	switch {
	case later == "referenced":
		return earlier
	case later == "deleted" || earlier == "referenced":
		return later
	case earlier == "created":
		return "created"
	default:
		return later
	}
}

func (s *Server) sessionFileDiffForMCP(ctx context.Context, actor Actor, session store.AgentSession, path, inputID string, maxBytes int) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, deviceFileRequestTimeout)
	defer cancel()
	diff, err := s.hub.ReadSessionFileDiff(ctx, session, path, inputID)
	if err != nil {
		return "", s.deviceReadError(ctx, session, err)
	}
	if err := s.readableSessionFile(ctx, actor, session, diff.Origin, diff.InsideWorkspace); err != nil {
		return "", err
	}
	header := []string{"path: " + diff.Path}
	if inputID != "" {
		header = append(header, "turn: "+inputID)
	} else {
		header = append(header, "turn: every turn of the session")
	}
	if diff.Added != nil && diff.Removed != nil {
		header = append(header, fmt.Sprintf("lines: +%d -%d", *diff.Added, *diff.Removed))
	}
	for _, note := range []struct {
		set  bool
		text string
	}{
		{diff.MayIncludeOtherEdits, "other edits: the diff may include changes another process made to the file"},
		{diff.ChangedSince, "changed since: the file changed again after the session's last write"},
		{diff.Truncated, "truncated: the device sent only part of the file"},
	} {
		if note.set {
			header = append(header, note.text)
		}
	}
	switch {
	case diff.Unavailable != "":
		return strings.Join(append(header, "no diff: "+diff.Unavailable), "\n"), nil
	case diff.Binary:
		return strings.Join(append(header, "no diff: a binary file"), "\n"), nil
	case diff.TooLarge:
		return strings.Join(append(header, "no diff: the file is too large for the device to keep copies of"), "\n"), nil
	}
	before, after := "", ""
	if diff.Before != nil {
		before = *diff.Before
	}
	if diff.After != nil {
		after = *diff.After
	}
	body, ok := textdiff.Unified(cmp.Or(diff.BeforeLabel, "before"), cmp.Or(diff.AfterLabel, "after"), before, after, diffContextLines)
	switch {
	case !ok:
		body = fmt.Sprintf("no diff: more than %d lines changed; scope=file reads the file as it is now", textdiff.MaxEdits)
	case body == "":
		body = "no change"
	}
	text := strings.Join(header, "\n") + "\n\n" + body
	if len(text) > maxBytes {
		text = text[:maxBytes] + fmt.Sprintf("\n…[truncated at maxBytes %d]", maxBytes)
	}
	return text, nil
}

func (s *Server) sessionFileForMCP(ctx context.Context, actor Actor, session store.AgentSession, path string, maxBytes int) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, deviceFileRequestTimeout)
	defer cancel()
	file, err := s.hub.ReadSessionFile(ctx, session, path)
	if err != nil {
		return "", s.deviceReadError(ctx, session, err)
	}
	if err := s.readableSessionFile(ctx, actor, session, file.Origin, file.InsideWorkspace); err != nil {
		return "", err
	}
	header := []string{"path: " + file.Path, "kind: " + file.Kind}
	if file.Bytes != nil {
		header = append(header, fmt.Sprintf("bytes: %d", *file.Bytes))
	}
	if file.ChangedSinceRecorded {
		header = append(header, "changed since: the file changed after the session recorded it")
	}
	content := file.Content
	switch {
	case file.Kind != "text" && content == "":
		content = "(not text: " + cmp.Or(file.MIMEType, file.Kind) + "; it is on the session's device at " + file.Path + ")"
	case file.Truncated:
		header = append(header, "truncated: the device sent only the start of the file")
	}
	text := strings.Join(header, "\n") + "\n\n" + content
	if len(text) > maxBytes {
		text = text[:maxBytes] + fmt.Sprintf("\n…[truncated at maxBytes %d]", maxBytes)
	}
	return text, nil
}

// readableSessionFile applies the web's rule: what the session's tools
// wrote and files inside its workspace are any reader's; a file outside it
// that an answer only named needs Member, as browsing the device would.
func (s *Server) readableSessionFile(ctx context.Context, actor Actor, session store.AgentSession, origin string, inside bool) error {
	if sessionFileReadableByViewer(store.SessionFileRead{Origin: origin, InsideWorkspace: inside}) {
		return nil
	}
	if scope, err := s.contextScope(ctx, actor); err == nil && scope.can(session.WorkspaceID, store.WorkspaceRoleMember) {
		return nil
	}
	return &mcpToolError{http.StatusForbidden, "this file is outside the session's workspace and only its answer named it: reading it needs Member in the workspace"}
}

// deviceReadError says why the session's device did not hand over a file.
func (s *Server) deviceReadError(ctx context.Context, session store.AgentSession, err error) error {
	var fileRefusal sessionFileRefusal
	var taskRefusal backgroundTaskRefusal
	device := "the session's device"
	if workspace, lookup := s.store.GetWorkspace(context.WithoutCancel(ctx), session.WorkspaceID); lookup == nil && workspace.DeviceLabel != "" {
		device = workspace.DeviceLabel
	}
	switch {
	case errors.As(err, &fileRefusal):
		return &mcpToolError{http.StatusNotFound, fileRefusal.reason}
	case errors.As(err, &taskRefusal):
		return &mcpToolError{http.StatusNotFound, taskRefusal.reason}
	case errors.Is(err, store.ErrNotFound), errors.Is(err, ErrLocalDaemonNotConnected):
		return &mcpToolError{http.StatusConflict, device + " is offline; its files can be read once it reconnects (list_resources shows which devices are online)"}
	case errors.Is(err, context.DeadlineExceeded):
		return &mcpToolError{http.StatusGatewayTimeout, fmt.Sprintf("%s did not answer within %d seconds; try again", device, int(deviceFileRequestTimeout/time.Second))}
	default:
		return err
	}
}

// mcpBackgroundTask is one command a session left running, from its
// latest report of them.
type mcpBackgroundTask struct {
	ID          string `json:"id"`
	Kind        string `json:"kind,omitempty"`
	Description string `json:"description"`
	Status      string `json:"status"`
	ExitCode    *int64 `json:"exitCode,omitempty"`
	StartedAt   string `json:"startedAt,omitempty"`
	EndedAt     string `json:"endedAt,omitempty"`
	HasOutput   bool   `json:"hasOutput"`
}

func sessionBackgroundList(session store.AgentSession) string {
	tasks := []mcpBackgroundTask{}
	for index := len(session.Events) - 1; index >= 0; index-- {
		metadata := session.Events[index].Metadata
		if metadata == nil || metadata.BackgroundTaskSnapshot == nil {
			continue
		}
		for _, task := range *metadata.BackgroundTaskSnapshot {
			tasks = append(tasks, mcpBackgroundTask{
				ID: task.ID, Kind: task.Kind, Description: oneLine(task.Description, inspectBeforeLimit), Status: task.Status,
				ExitCode: task.ExitCode, StartedAt: task.StartedAt, EndedAt: task.EndedAt, HasOutput: task.HasOutput,
			})
		}
		break
	}
	more := "taskId=<an id above> reads the end of its output."
	if len(tasks) == 0 {
		more = "It left no work running in the background (only Claude sessions report it)."
	}
	hint, _ := json.Marshal(more)
	return "{\n  \"tasks\": " + encodeLines(tasks) + ",\n  \"more\": " + string(hint) + "\n}"
}

func (s *Server) backgroundOutputForMCP(ctx context.Context, actor Actor, session store.AgentSession, taskID string, maxBytes int) (string, error) {
	if !backgroundTaskID.MatchString(taskID) {
		return "", &mcpToolError{http.StatusBadRequest, "taskId is not a background task id: scope=background lists them"}
	}
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return "", err
	}
	if !scope.can(session.WorkspaceID, store.WorkspaceRoleMember) {
		return "", &mcpToolError{http.StatusForbidden, "reading a background task's output needs Member in the session's workspace: its commands and output can carry anything the session worked on"}
	}
	ctx, cancel := context.WithTimeout(ctx, deviceFileRequestTimeout)
	defer cancel()
	output, err := s.hub.ReadBackgroundTaskOutput(ctx, session, taskID, backgroundOutputRead{})
	if err != nil {
		return "", s.deviceReadError(ctx, session, err)
	}
	header := []string{"task: " + taskID, fmt.Sprintf("bytes: %d", output.Bytes)}
	if output.Command != "" {
		header = append(header, "command: "+oneLine(output.Command, inspectDetailLimit))
	}
	content := output.Content
	if room := maxBytes - len(strings.Join(header, "\n")) - 40; len(content) > room {
		// The end is what a reader of a log wants: how it finished.
		content = content[len(content)-max(room, 0):]
		header = append(header, fmt.Sprintf("shown: its last %d bytes", len(content)))
	} else if output.Truncated {
		header = append(header, "shown: the end of its log")
	}
	return strings.Join(header, "\n") + "\n\n" + content, nil
}
