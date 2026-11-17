package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/channels"
	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

// A message channel's runtime (DEV-203 phase 2): its sessions run in a
// workspace of their own that is read-only for them, whose AGENTS.md is the
// person's instructions for the channel, edited from the Web with history.

// channelInstructionsPath is the instructions file of a channel workspace.
const channelInstructionsPath = "AGENTS.md"

type wsWriteFilePayload struct {
	WorkspaceID    string  `json:"workspaceId"`
	Path           string  `json:"path"`
	Content        string  `json:"content"`
	ExpectedSha256 *string `json:"expectedSha256,omitempty"`
}

type wsFileWrittenPayload struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
	Sha256      string `json:"sha256"`
	Bytes       int    `json:"bytes"`
	Error       string `json:"error,omitempty"`
	Code        string `json:"code,omitempty"`
}

func (p wsFileWrittenPayload) refusal() error {
	if p.Error == "" {
		return nil
	}
	switch p.Code {
	case "conflict":
		return &statusError{http.StatusConflict, errors.New("the file changed on the device since it was read: " + p.Error)}
	case "invalid_path", "too_large":
		return &statusError{http.StatusBadRequest, errors.New(p.Error)}
	}
	return &statusError{http.StatusBadGateway, errors.New(p.Error)}
}

// writeWorkspaceTextFile asks the workspace's device to replace one text
// file; expected, when set, is the sha256 the file must have now ("" for a
// file that must not exist).
func (s *Server) writeWorkspaceTextFile(ctx context.Context, workspace store.WorkspaceProjection, path, content string, expected *string) (string, error) {
	connection := s.hub.connectionFor(workspace.DeviceID)
	if connection == nil {
		return "", &statusError{http.StatusConflict, errors.New("the workspace's device is not connected")}
	}
	if !connection.hasCapability(store.DaemonCapabilityWorkspaceFileWrite) {
		return "", &statusError{http.StatusConflict, errors.New("the workspace's device runs a Worker too old to write the file; update it")}
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	value, err := callDevice[wsFileWrittenPayload](ctx, connection, wsWriteFileType,
		wsWriteFilePayload{WorkspaceID: workspace.ID, Path: path, Content: content, ExpectedSha256: expected})
	return value.Sha256, err
}

func clipRunes(s string, limit int) string {
	if utf8.RuneCountInString(s) <= limit {
		return s
	}
	return string([]rune(s)[:limit])
}

func contentSha256(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// checkMessageChannelWorkspace accepts a workspace the person chose for a
// channel: one they work in, on the assistant's home device, not the home
// itself.
func (s *Server) checkMessageChannelWorkspace(ctx context.Context, r *http.Request, agent store.PersonalAgent, workspaceID string) error {
	scope, err := s.requestScope(r)
	if err != nil {
		return err
	}
	if !scope.can(workspaceID, store.WorkspaceRoleMember) {
		return &statusError{http.StatusBadRequest, errors.New("choose a workspace you work in")}
	}
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return err
	}
	if workspace.ID == agent.WorkspaceID {
		return &statusError{http.StatusBadRequest, errors.New("the assistant's own folder can't be a channel's workspace: channel sessions may not write it")}
	}
	if workspace.DeviceID != agent.HomeDeviceID {
		return &statusError{http.StatusBadRequest, errors.New("the channel's workspace must be on the assistant's computer")}
	}
	return nil
}

// createMessageChannelWorkspace makes the channel's workspace inside the
// assistant's home, channels/<slug>/ (DEV-251), its AGENTS.md seeded from
// the channel's settings and the generated CLAUDE.md beside it.
func (s *Server) createMessageChannelWorkspace(ctx context.Context, agent store.PersonalAgent, channel store.MessageChannelRecord) (string, error) {
	label, hint := s.messageChannelSourceLabel(ctx, channel), s.messageChannelContextHint(ctx, channel)
	seed := channels.SeedInstructions(channel.MessageChannel, label, hint)
	name := strings.TrimSpace(agent.Name)
	if name == "" {
		name = "助理"
	}
	path, err := s.channelWorkspacePath(ctx, agent, channel)
	if err != nil {
		return "", err
	}
	workspace, err := paWorkspaces{s}.CreateWorkspace(ctx, personalagent.WorkspaceActor{UserID: agent.UserID}, personalagent.NewWorkspace{
		DeviceID: agent.HomeDeviceID, Path: path,
		Name:    name + " · 消息通道 · " + clipRunes(channel.Name, 40),
		Purpose: "Message channel " + channel.ID + ": its sessions run here, read-only; AGENTS.md holds the person's instructions for it.",
		Create: &personalagent.WorkspaceSource{Kind: personalagent.WorkspaceCreateEmpty, Files: []personalagent.WorkspaceFile{
			{Path: channelInstructionsPath, Content: seed},
			prompt.ChannelClaudeFile(),
		}},
	})
	if err != nil {
		return "", err
	}
	if err := s.addChannelInstructionsRevision(ctx, workspace.ID, seed, "seed"); err != nil {
		return "", err
	}
	return workspace.ID, nil
}

// channelWorkspacePath is where a channel's workspace lives: the assistant
// home's channels/<slug> (DEV-251). A slug another channel already uses
// gets -2, -3, …
func (s *Server) channelWorkspacePath(ctx context.Context, agent store.PersonalAgent, channel store.MessageChannelRecord) (string, error) {
	home, err := s.store.GetWorkspace(ctx, agent.WorkspaceID)
	if err != nil {
		return "", err
	}
	taken := map[string]bool{}
	if st, ok := s.store.(store.MessageChannelStore); ok {
		records, err := st.ListMessageChannels(ctx, agent.UserID, agent.ID)
		if err != nil {
			return "", err
		}
		for _, record := range records {
			if record.ID == channel.ID || record.WorkspaceID == "" {
				continue
			}
			if workspace, err := s.store.GetWorkspace(ctx, record.WorkspaceID); err == nil {
				taken[strings.ToLower(workspace.LocalPath)] = true
			}
		}
	}
	// A folder already in channels/ that no channel uses (a leftover) would
	// make the device refuse a new folder with the same name; leave it alone.
	if s.hub != nil && s.hub.HasConnection(home.DeviceID) {
		if entries, err := s.hub.ListWorkspaceTree(ctx, home, "channels"); err == nil {
			for _, entry := range entries {
				if entry.IsDirectory {
					taken[strings.ToLower(store.JoinDevicePath(home.LocalPath, "channels", entry.Name))] = true
				}
			}
		}
	}
	for n := 1; ; n++ {
		slug := channels.FolderSlug(channel.MessageChannel)
		if n > 1 {
			slug = fmt.Sprintf("%s-%d", slug, n)
		}
		path := store.JoinDevicePath(home.LocalPath, "channels", slug)
		if !taken[strings.ToLower(path)] {
			return path, nil
		}
	}
}

// seedMessageChannelInstructions writes the seed AGENTS.md into a chosen
// workspace that has none; an existing file is left as it is.
func (s *Server) seedMessageChannelInstructions(ctx context.Context, channel store.MessageChannelRecord, onlyIfMissing bool) error {
	workspace, err := s.store.GetWorkspace(ctx, channel.WorkspaceID)
	if err != nil {
		return err
	}
	seed := channels.SeedInstructions(channel.MessageChannel, s.messageChannelSourceLabel(ctx, channel), s.messageChannelContextHint(ctx, channel))
	missing := ""
	var expected *string
	if onlyIfMissing {
		expected = &missing
	}
	if _, err := s.writeWorkspaceTextFile(ctx, workspace, channelInstructionsPath, seed, expected); err != nil {
		var status *statusError
		if errors.As(err, &status) && status.status == http.StatusConflict && onlyIfMissing {
			return nil
		}
		return err
	}
	return s.addChannelInstructionsRevision(ctx, workspace.ID, seed, "seed")
}

// addChannelInstructionsRevision keeps a version of the channel
// workspace's AGENTS.md among the workspace's file versions (DEV-223).
func (s *Server) addChannelInstructionsRevision(ctx context.Context, workspaceID, content, source string) error {
	st, err := s.workspaceFileStore()
	if err != nil {
		return err
	}
	return addFileRevision(ctx, st, workspaceID, channelInstructionsPath, content, source)
}

// ensureMessageChannelWorkspaces gives every channel without a workspace
// one (channels made before DEV-203 phase 2), and keeps each channel's
// workspace inside the assistant home under channels/<slug>/ (DEV-251),
// moving one made before the nested layout when no channel turn is running.
func (s *Server) ensureMessageChannelWorkspaces(ctx context.Context) {
	st, ok := s.store.(store.MessageChannelStore)
	if !ok {
		return
	}
	records, err := st.ListAllMessageChannels(ctx)
	if err != nil {
		return
	}
	for _, record := range records {
		agent, err := s.store.GetAssistant(ctx, record.AssistantID)
		if err != nil || s.hub == nil || !s.hub.HasConnection(agent.HomeDeviceID) {
			continue
		}
		if record.WorkspaceID == "" {
			workspaceID, err := s.createMessageChannelWorkspace(ctx, agent, record)
			if err != nil {
				s.connectors.ServerHeld.Logf("message channel %s: create its workspace: %v", record.ID, err)
				continue
			}
			record.WorkspaceID, record.UpdatedAt = workspaceID, time.Now().UTC().Format(time.RFC3339Nano)
			if err := st.SaveMessageChannel(ctx, record); err != nil {
				s.connectors.ServerHeld.Logf("message channel %s: save its workspace: %v", record.ID, err)
			}
			continue
		}
		s.relocateMessageChannelWorkspace(ctx, agent, record)
	}
}

// relocateMessageChannelWorkspace moves a channel workspace left at the
// old top-level location into the assistant home (DEV-251), keeping its id,
// chats and file versions. A queued or running channel turn defers the move
// to a later pass; the existing relink then updates the workspace record and
// makes the chats resumable in the new folder.
func (s *Server) relocateMessageChannelWorkspace(ctx context.Context, agent store.PersonalAgent, record store.MessageChannelRecord) {
	workspace, err := s.store.GetWorkspace(ctx, record.WorkspaceID)
	if err != nil || workspace.DeviceID != agent.HomeDeviceID {
		return
	}
	// Only the folder Foundry made for the channel moves. A workspace the
	// person chose for it is their project, and its folder stays where it is.
	if !strings.HasPrefix(store.LastDevicePathElement(workspace.LocalPath), "message-channel-") {
		s.ensureChannelClaudeFile(ctx, record, workspace)
		return
	}
	desired, err := s.channelWorkspacePath(ctx, agent, record)
	if err != nil {
		return
	}
	if !sameDevicePath(workspace.LocalPath, desired) {
		if !s.workspaceIdle(ctx, workspace) {
			return
		}
		if refuseWhileMoving(ctx, s.store, workspace.ID, "moved") != nil {
			return
		}
		refs, err := s.store.WorkspaceNativeSessions(ctx, workspace.ID)
		if err != nil {
			return
		}
		runCtx, cancel := context.WithTimeout(ctx, time.Minute)
		defer cancel()
		if _, err := s.relinkFolder(runCtx, workspace, desired, refs, true); err != nil {
			s.connectors.ServerHeld.Logf("message channel %s: move its workspace to %s: %v", record.ID, desired, err)
			return
		}
		s.connectors.ServerHeld.Logf("message channel %s: workspace moved to %s", record.ID, desired)
		if workspace, err = s.store.GetWorkspace(ctx, workspace.ID); err != nil {
			return
		}
	}
	s.ensureChannelClaudeFile(ctx, record, workspace)
}

// ensureChannelClaudeFile puts the generated CLAUDE.md into a channel
// workspace made before DEV-251. Its run supplies one anyway; this makes the
// file visible in the Web.
func (s *Server) ensureChannelClaudeFile(ctx context.Context, record store.MessageChannelRecord, workspace store.WorkspaceProjection) {
	missing := ""
	if _, err := s.writeWorkspaceTextFile(ctx, workspace, prompt.ChannelClaudePath, prompt.ChannelClaudeFile().Content, &missing); err != nil {
		var status *statusError
		if !errors.As(err, &status) || status.status != http.StatusConflict {
			s.connectors.ServerHeld.Logf("message channel %s: write its CLAUDE.md: %v", record.ID, err)
		}
	}
}

// workspaceIdle reports that no session of the workspace is queued or
// running, so its folder may be moved.
func (s *Server) workspaceIdle(ctx context.Context, workspace store.WorkspaceProjection) bool {
	sessions, err := s.store.UnsettledAgentSessionsOnDevice(ctx, workspace.DeviceID)
	if err != nil {
		return false
	}
	for _, session := range sessions {
		if session.WorkspaceID == workspace.ID {
			return false
		}
	}
	return true
}

// sameDevicePath compares two device paths ignoring a trailing separator.
func sameDevicePath(left, right string) bool {
	return strings.TrimRight(left, store.DevicePathSeparators) == strings.TrimRight(right, store.DevicePathSeparators)
}

// parseChannelInbox reads mc:<channel>:<conversation hash>[:<segment>].
func parseChannelInbox(channel string) (channelID string, segment int, ok bool) {
	parts := strings.Split(channel, ":")
	if len(parts) < 3 || len(parts) > 4 || parts[0] != "mc" {
		return "", 0, false
	}
	if len(parts) == 4 {
		n, err := strconv.Atoi(parts[3])
		if err != nil {
			return "", 0, false
		}
		segment = n
	}
	return parts[1], segment, true
}

// messageChannelTarget is where a channel conversation's turn runs: the
// channel's workspace, read-only for the session (assistant.ChannelTarget).
func (s *Server) messageChannelTarget(ctx context.Context, entry store.PersonalAgentInboxEntry) (assistant.ChannelTarget, error) {
	st, err := s.messageChannelStore()
	if err != nil {
		return assistant.ChannelTarget{}, err
	}
	channelID, segment, ok := parseChannelInbox(entry.Channel)
	if !ok {
		return assistant.ChannelTarget{}, fmt.Errorf("not a message channel inbox: %s", entry.Channel)
	}
	channel, err := st.GetMessageChannel(ctx, channelID)
	if err != nil {
		return assistant.ChannelTarget{}, err
	}
	if channel.WorkspaceID == "" {
		return assistant.ChannelTarget{}, errors.New("the channel has no workspace yet")
	}
	workspace, err := s.store.GetWorkspace(ctx, channel.WorkspaceID)
	if err != nil {
		return assistant.ChannelTarget{}, err
	}
	records, err := st.ListMessageChannelDeliveries(ctx, channel.ID, []string{store.MessageDeliveryQueued}, 200)
	if err != nil {
		return assistant.ChannelTarget{}, err
	}
	var turn []store.MessageChannelDeliveryRecord
	for _, record := range records {
		if record.InboxChannel == entry.Channel && (record.InboxID == "" || record.InboxID == entry.ID) {
			turn = append(turn, record)
		}
	}
	target := assistant.ChannelTarget{WorkspaceID: workspace.ID, Title: channel.Name}
	sessionKey := ""
	if len(turn) > 0 {
		first := turn[len(turn)-1]
		sessionKey = first.SessionKey
		name := first.Envelope.Conversation.Name
		if name == "" {
			name = first.Envelope.Sender.Name
		}
		if name != "" {
			target.Title += " · " + name
		}
		// A thread is named as what it is: a thread under someone's message
		// (DEV-268).
		if first.Envelope.Thread.ID != "" {
			target.Title += " · 话题"
		}
		if segment > 0 {
			zone := time.Local
			if agent, err := s.store.GetAssistant(ctx, channel.AssistantID); err == nil && s.assistant != nil {
				zone = s.assistant.PersonLocation(ctx, agent)
			}
			target.Title += " · " + time.Now().In(zone).Format("01-02 15:04")
		}
	}
	target.Title = clipRunes(target.Title, 120)
	// The source's own events, as a file the session can read.
	var raw []string
	for i := len(turn) - 1; i >= 0; i-- {
		if turn[i].RawJSON != "" {
			raw = append(raw, turn[i].RawJSON)
		}
	}
	if len(raw) > 0 {
		body := "[\n" + strings.Join(raw, ",\n") + "\n]\n"
		attachment, err := s.storeAttachment(ctx, workspace, time.Now(), 0, "message-channel-event.json", "application/json",
			int64(len(body)), strings.NewReader(body).Read)
		if err == nil {
			target.Attachments = append(target.Attachments, attachment)
		} else {
			s.connectors.ServerHeld.Logf("message channel %s: attach its raw event: %v", channel.ID, err)
		}
	}
	target.OnSession = func(ctx context.Context, sessionID string) error {
		return st.RecordMessageChannelSession(ctx, store.MessageChannelSession{
			SessionID: sessionID, ChannelID: channel.ID, AssistantID: channel.AssistantID, SessionKey: sessionKey, Segment: segment,
			WorkspaceID: workspace.ID, Title: target.Title,
		})
	}
	return target, nil
}

// messageChannelSessionAssistant is the assistant a channel session works
// for (assistant.Service.Conversation).
func (s *Server) messageChannelSessionAssistant(ctx context.Context, sessionID string) (string, bool) {
	st, ok := s.store.(store.MessageChannelStore)
	if !ok {
		return "", false
	}
	session, err := st.GetMessageChannelSession(ctx, sessionID)
	if err != nil {
		return "", false
	}
	return session.AssistantID, true
}

// messageChannelContextHint is the source's context command for the
// person's language.
func (s *Server) messageChannelContextHint(ctx context.Context, channel store.MessageChannelRecord) string {
	account, err := s.messageChannelAccount(ctx, channel.UserID, channel.Source.AccountID)
	if err != nil {
		return ""
	}
	app, data, err := s.messageChannelInstance(ctx, channel.UserID, account)
	if err != nil {
		return ""
	}
	spec, _ := s.messageChannelFeed(ctx, channel.UserID, app, data)
	if spec == nil {
		return ""
	}
	language := ""
	if person, err := s.store.GetUser(ctx, channel.UserID); err == nil {
		language = person.Locale
	}
	return channels.LongPoll{Spec: *spec}.ContextHint(language)
}

// messageChannelReplyCommand is the source's reply command for a
// conversation kind.
func (s *Server) messageChannelReplyCommand(ctx context.Context, channel store.MessageChannelRecord, kind string) string {
	account, err := s.messageChannelAccount(ctx, channel.UserID, channel.Source.AccountID)
	if err != nil {
		return ""
	}
	app, data, err := s.messageChannelInstance(ctx, channel.UserID, account)
	if err != nil {
		return ""
	}
	spec, _ := s.messageChannelFeed(ctx, channel.UserID, app, data)
	if spec == nil {
		return ""
	}
	return channels.LongPoll{Spec: *spec}.Reply(kind)
}

// messageChannelOwnWrites is the set of messages the channel's source
// account created through Foundry's gateway from sessions that work for the
// channel's assistant: its channel sessions, its home conversation, and the
// helpers those started (DEV-233, DEV-243). A write by any other session of
// the same account (an agent session the person ran, a script) is not the
// assistant's own and must stay deliverable. It reads only this event kind
// in the last 48 hours (the rollover is 4 hours), not the account's whole
// audit trail; an error is passed on so the batch is not delivered without
// the check.
func (s *Server) messageChannelOwnWrites(ctx context.Context, channel store.MessageChannelRecord) (map[string]bool, error) {
	since := time.Now().UTC().Add(-48 * time.Hour).Format(time.RFC3339Nano)
	events, err := s.store.ListExternalAccountEventsByKind(ctx, channel.Source.AccountID, connectors.ExtensionWriteCreatedMessage, since, 5000)
	if err != nil {
		return nil, err
	}
	own := map[string]bool{}
	belongs := map[string]bool{}
	for _, event := range events {
		if event.SessionID == "" || !s.messageChannelSessionBelongs(ctx, channel.AssistantID, event.SessionID, belongs) {
			continue
		}
		var detail struct {
			MessageID string `json:"messageId"`
		}
		if json.Unmarshal([]byte(event.Detail), &detail) == nil && detail.MessageID != "" {
			own[detail.MessageID] = true
		}
	}
	return own, nil
}

// messageChannelSessionBelongs reports whether session works for
// assistantID: the assistant's own conversation (its channel session or its
// home conversation) or a helper one of those started, which
// permission.Resolve finds by walking parent links. belongs caches the
// answer per session across one batch.
func (s *Server) messageChannelSessionBelongs(ctx context.Context, assistantID, sessionID string, belongs map[string]bool) bool {
	if assistantID == "" {
		return false
	}
	if known, ok := belongs[sessionID]; ok {
		return known
	}
	session, err := s.store.GetAgentSessionSummary(ctx, sessionID)
	current := false
	if err == nil {
		access, accessErr := permission.Resolve(ctx, s.store, session)
		current = accessErr == nil && access.Applicable && access.Agent.ID == assistantID
	}
	belongs[sessionID] = current
	return current
}

// messageChannelSessionState is an earlier channel session as the
// dispatcher weighs it: running, open work (an open item waiting for the
// person or a helper still working), and its last activity.
func (s *Server) messageChannelSessionState(ctx context.Context, sessionID string) (channels.SessionState, bool) {
	session, err := s.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil {
		return channels.SessionState{}, false
	}
	state := channels.SessionState{Running: store.IsActiveSessionStatus(session.Status), Replaced: session.Status == "failed" || session.Status == "canceled" ||
		session.WorkspaceAccess != store.SessionWorkspaceAccessRead}
	for _, at := range []string{session.LastActivityAt, session.CompletedAt, session.StartedAt} {
		if parsed, err := time.Parse(time.RFC3339Nano, at); err == nil {
			state.LastActive = parsed
			break
		}
	}
	if children, err := s.store.CountActiveAgentChildren(ctx, sessionID); err == nil && children > 0 {
		state.OpenWork = true
	}
	if items, err := s.store.ListPendingItems(ctx, session.CreatedByUserID, []string{store.PendingOpen}, "", 500); err == nil {
		for _, item := range items {
			if item.SessionID == sessionID {
				state.OpenWork = true
				break
			}
		}
	}
	return state, true
}

// messageChannelWorking reports whether a channel turn still does work: its
// session's own turn is active, or a session it started is (DEV-268). The
// acknowledgement reaction and the context window follow it.
func (s *Server) messageChannelWorking(ctx context.Context, sessionID string) (bool, error) {
	if sessionID == "" {
		return false, nil
	}
	session, err := s.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	if store.IsActiveSessionStatus(session.Status) {
		return true, nil
	}
	descendants, err := s.store.CountActiveAgentDescendants(ctx, sessionID)
	if err != nil {
		return false, err
	}
	return descendants > 0, nil
}

// messageChannelHandOver reports whether the assistant turn that ran a channel
// message's inbox entry left an item with the person that is still open: the
// reaction says that turn is on the request, not done (DEV-279). Hand-overs of
// other turns of the same conversation do not count.
func (s *Server) messageChannelHandOver(ctx context.Context, assistantID, inboxID string) (bool, error) {
	if inboxID == "" {
		return false, nil
	}
	entry, err := s.store.GetPersonalAgentInbox(ctx, assistantID, inboxID)
	if err != nil {
		return false, err
	}
	return s.store.OpenHandOverForInput(ctx, entry.InputID)
}

// messageChannelContext steers other participants' messages into a running
// turn as facts, at a boundary; it never starts a turn. false means the
// session is not running now and the messages wait.
func (s *Server) messageChannelContext(ctx context.Context, channel store.MessageChannelRecord, sessionID string, turn channels.Turn) (bool, error) {
	session, err := s.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil || !store.IsActiveSessionStatus(session.Status) {
		return false, nil
	}
	_, err = s.sessionService.Send(ctx, sessionID, store.SendAgentSessionInput{
		Prompt: turn.Text, ChannelOrigin: turn.Origin, Delivery: store.DeliveryBoundary,
		InputID: uuid.NewSHA1(uuid.NameSpaceOID, []byte(turn.MessageID)).String(),
	}, nil)
	if err != nil {
		return false, nil
	}
	return true, nil
}

// messageChannelWorkspaceView is where the channel's sessions run, for the
// settings.
func (s *Server) messageChannelWorkspaceView(ctx context.Context, channel store.MessageChannelRecord) *store.MessageChannelWorkspace {
	if channel.WorkspaceID == "" {
		return nil
	}
	workspace, err := s.store.GetWorkspace(ctx, channel.WorkspaceID)
	if err != nil {
		return nil
	}
	view := &store.MessageChannelWorkspace{ID: workspace.ID, Name: workspace.Name, DeviceID: workspace.DeviceID,
		DeviceName: s.deviceLabel(ctx, workspace.DeviceID), Path: workspace.LocalPath, Skills: []string{}}
	if bindings, err := s.store.ListWorkspaceSkillBindings(ctx, workspace.ID); err == nil {
		for _, binding := range bindings {
			name := binding.SkillID
			if skill, err := s.store.GetPromotedSkill(ctx, binding.SkillID); err == nil && skill.Name != "" {
				name = skill.Name
			}
			view.Skills = append(view.Skills, name)
		}
	}
	slices.Sort(view.Skills)
	return view
}

// --- the person's API ---

// The channel workspace's AGENTS.md is edited, with its versions, in the
// assistant's workspace files (assistant_files.go).

// handleMessageChannelNewSession makes a conversation's next message start
// a new session, as the person asked (「下次开新会话」).
func (s *Server) handleMessageChannelNewSession(w http.ResponseWriter, r *http.Request) {
	_, record, _, ok := s.messageChannelOf(w, r)
	if !ok {
		return
	}
	var input store.MessageChannelRolloverInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.SessionKey) == "" || s.messageChannels == nil {
		writeError(w, http.StatusBadRequest, "name the conversation (sessionKey)")
		return
	}
	err := s.messageChannels.RequestNewSession(r.Context(), record.ID, input.SessionKey)
	writeResult(w, map[string]string{"sessionKey": input.SessionKey, "next": "new"}, err)
}
