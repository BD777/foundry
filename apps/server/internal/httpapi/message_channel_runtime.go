package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/channels"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
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

// createMessageChannelWorkspace makes the channel's workspace beside the
// assistant's home, its AGENTS.md seeded from the channel's settings.
func (s *Server) createMessageChannelWorkspace(ctx context.Context, agent store.PersonalAgent, channel store.MessageChannelRecord) (string, error) {
	label, hint := s.messageChannelSourceLabel(ctx, channel), s.messageChannelContextHint(ctx, channel)
	seed := channels.SeedInstructions(channel.MessageChannel, label, hint)
	name := strings.TrimSpace(agent.Name)
	if name == "" {
		name = "助理"
	}
	folder := "message-channel-" + strings.TrimPrefix(channel.ID, "mch_")
	if len(folder) > 40 {
		folder = folder[:40]
	}
	workspace, err := paWorkspaces{s}.CreateWorkspace(ctx, personalagent.WorkspaceActor{UserID: agent.UserID}, personalagent.NewWorkspace{
		DeviceID: agent.HomeDeviceID, FolderName: folder,
		Name:    name + " · 消息通道 · " + clipRunes(channel.Name, 40),
		Purpose: "Message channel " + channel.ID + ": its sessions run here, read-only; AGENTS.md holds the person's instructions for it.",
		Create:  &personalagent.WorkspaceSource{Kind: personalagent.WorkspaceCreateEmpty, Files: []personalagent.WorkspaceFile{{Path: channelInstructionsPath, Content: seed}}},
	})
	if err != nil {
		return "", err
	}
	if err := s.addChannelInstructionsRevision(ctx, workspace.ID, seed, "seed"); err != nil {
		return "", err
	}
	return workspace.ID, nil
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
// one (channels made before DEV-203 phase 2), when the assistant's computer
// is online; its AGENTS.md carries the channel's earlier guidance.
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
		if record.WorkspaceID != "" {
			continue
		}
		agent, err := s.store.GetAssistant(ctx, record.AssistantID)
		if err != nil || s.hub == nil || !s.hub.HasConnection(agent.HomeDeviceID) {
			continue
		}
		workspaceID, err := s.createMessageChannelWorkspace(ctx, agent, record)
		if err != nil {
			s.connectors.ServerHeld.Logf("message channel %s: create its workspace: %v", record.ID, err)
			continue
		}
		record.WorkspaceID, record.UpdatedAt = workspaceID, time.Now().UTC().Format(time.RFC3339Nano)
		if err := st.SaveMessageChannel(ctx, record); err != nil {
			s.connectors.ServerHeld.Logf("message channel %s: save its workspace: %v", record.ID, err)
		}
	}
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
