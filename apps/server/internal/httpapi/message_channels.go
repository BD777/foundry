package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/foundry-dev/foundry/apps/server/internal/channels"
	"github.com/foundry-dev/foundry/apps/server/internal/jsonempty"
	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Message channels (DEV-203, docs/devlog/DEV-203-message-channels.md): the
// person's settings API, the runner's ports over connector extension
// instances and the assistant inbox, and the channel skills of an
// assistant's home.

const maxMessageChannelsPerAssistant = 20

// messageChannelStoreOf is st's message channel store, nil without one.
func messageChannelStoreOf(st store.Store) store.MessageChannelStore {
	channels, _ := st.(store.MessageChannelStore)
	return channels
}

func (s *Server) messageChannelStore() (store.MessageChannelStore, error) {
	st, ok := s.store.(store.MessageChannelStore)
	if !ok {
		return nil, &statusError{http.StatusNotImplemented, errors.New("message channels are not available")}
	}
	return st, nil
}

// newMessageChannelRunner is the runner over this server, nil when the store
// keeps no channels.
func newMessageChannelRunner(s *Server) *channels.Runner {
	st, ok := s.store.(store.MessageChannelStore)
	if !ok {
		return nil
	}
	return channels.NewRunner(channels.Ports{
		Store: st, Open: s.openMessageChannelSource, Inbox: messageChannelInbox{s},
		Tell: s.tellAboutMessageChannel, SourceLabel: s.messageChannelSourceLabel,
		ContextHint: s.messageChannelContextHint, Session: s.messageChannelSessionState,
	})
}

// --- the person's API ---

func (s *Server) handleListMessageChannels(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	st, err := s.messageChannelStore()
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	records, err := st.ListMessageChannels(r.Context(), agent.UserID, agent.ID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	list := store.MessageChannelList{Channels: []store.MessageChannelView{}, Sources: []store.MessageChannelSource{}}
	for _, record := range records {
		view, err := s.messageChannelView(r.Context(), agent, record)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		list.Channels = append(list.Channels, view)
	}
	if list.ChannelSessionIDs, err = st.MessageChannelSessions(r.Context(), agent.ID, ""); err != nil {
		writeResult(w, nil, err)
		return
	}
	list.Sources, err = s.messageChannelSources(r.Context(), agent.UserID)
	writeResult(w, list, err)
}

func (s *Server) handleCreateMessageChannel(w http.ResponseWriter, r *http.Request) {
	s.saveMessageChannel(w, r, "")
}

func (s *Server) handleUpdateMessageChannel(w http.ResponseWriter, r *http.Request) {
	s.saveMessageChannel(w, r, r.PathValue("channel"))
}

func (s *Server) saveMessageChannel(w http.ResponseWriter, r *http.Request, id string) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	st, err := s.messageChannelStore()
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	var input store.MessageChannelInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	ctx := r.Context()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	record := store.MessageChannelRecord{UserID: agent.UserID}
	wasEnabled := false
	if id == "" {
		existing, err := st.ListMessageChannels(ctx, agent.UserID, agent.ID)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		if len(existing) >= maxMessageChannelsPerAssistant {
			writeError(w, http.StatusConflict, fmt.Sprintf("an assistant has at most %d message channels", maxMessageChannelsPerAssistant))
			return
		}
		record.ID, record.AssistantID, record.CreatedAt = "mch_"+strings.ReplaceAll(uuid.NewString(), "-", "")[:20], agent.ID, now
	} else {
		record, err = st.GetMessageChannel(ctx, id)
		if err != nil || record.UserID != agent.UserID || record.AssistantID != agent.ID {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		wasEnabled = record.Enabled
	}
	channel, err := s.cleanMessageChannelInput(ctx, r, agent, input)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	record.Name, record.Enabled, record.Source, record.Filters = channel.Name, channel.Enabled, channel.Source, channel.Filters
	record.Guide, record.SessionKey, record.Scope, record.Limits = channel.Guide, channel.SessionKey, channel.Scope, channel.Limits
	record.Session = channel.Session
	record.SkillName, record.UpdatedAt = channels.SkillName(record.MessageChannel), now
	if channel.WorkspaceID != "" && channel.WorkspaceID != record.WorkspaceID {
		if err := s.checkMessageChannelWorkspace(ctx, r, agent, channel.WorkspaceID); err != nil {
			writeResult(w, nil, err)
			return
		}
		record.WorkspaceID = channel.WorkspaceID
		if err := s.seedMessageChannelInstructions(ctx, record, true); err != nil {
			writeResult(w, nil, err)
			return
		}
	}
	if record.WorkspaceID == "" {
		workspaceID, err := s.createMessageChannelWorkspace(ctx, agent, record)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		record.WorkspaceID = workspaceID
	}
	if err := st.SaveMessageChannel(ctx, record); err != nil {
		writeResult(w, nil, err)
		return
	}
	if record.Enabled && !wasEnabled && (id == "" || input.ResumeFromNow) {
		// A new channel, or one the person resumes from now, starts at the
		// feed's present: nothing older is replayed.
		runtime, _ := st.GetMessageChannelRuntime(ctx, record.ID)
		runtime.ChannelID, runtime.Cursor, runtime.State, runtime.Detail = record.ID, "", channels.StateStarting, ""
		if err := st.SaveMessageChannelRuntime(ctx, runtime); err != nil {
			writeResult(w, nil, err)
			return
		}
	}
	if s.messageChannels != nil {
		s.messageChannels.Kick()
	}
	view, err := s.messageChannelView(ctx, agent, record)
	status := http.StatusOK
	if id == "" {
		status = http.StatusCreated
	}
	writeResultWithStatus(w, status, view, err)
}

func (s *Server) handleDeleteMessageChannel(w http.ResponseWriter, r *http.Request) {
	agent, record, st, ok := s.messageChannelOf(w, r)
	if !ok {
		return
	}
	if err := st.DeleteMessageChannel(r.Context(), agent.UserID, record.ID); err != nil {
		writeResult(w, nil, err)
		return
	}
	if s.messageChannels != nil {
		s.messageChannels.Kick()
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMessageChannelDeliveries(w http.ResponseWriter, r *http.Request) {
	agent, record, st, ok := s.messageChannelOf(w, r)
	if !ok {
		return
	}
	statuses := []string{store.MessageDeliveryHeld, store.MessageDeliveryQueued, store.MessageDeliveryDelivered, store.MessageDeliveryDone, store.MessageDeliveryFailed}
	if r.URL.Query().Get("dropped") == "1" {
		statuses = nil
	}
	records, err := st.ListMessageChannelDeliveries(r.Context(), record.ID, statuses, 50)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	list := store.MessageChannelDeliveryList{Deliveries: []store.MessageChannelDelivery{}}
	actions := s.messageChannelActions(r.Context(), agent, record, records)
	for _, item := range records {
		delivery := item.MessageChannelDelivery
		delivery.Actions = actions[item.ID]
		list.Deliveries = append(list.Deliveries, delivery)
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleReleaseMessageChannel(w http.ResponseWriter, r *http.Request) {
	_, record, _, ok := s.messageChannelOf(w, r)
	if !ok {
		return
	}
	if s.messageChannels == nil {
		writeError(w, http.StatusNotImplemented, "message channels are not running")
		return
	}
	released, err := s.messageChannels.Release(r.Context(), record.ID)
	writeResult(w, map[string]int{"released": released}, err)
}

// handleGrantMessageChannelSource is the person's one click that lets the
// assistant use a channel's source: its permission package allows the
// account (read and write). The assistant's own conversations reach every
// account the package allows, so its home needs no binding.
func (s *Server) handleGrantMessageChannelSource(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input struct {
		AccountID string `json:"accountId"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	ctx := r.Context()
	account, err := s.messageChannelAccount(ctx, agent.UserID, input.AccountID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	pkg, err := s.store.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	access := permission.Access{Applicable: true, Agent: agent, Package: pkg}
	if access.ConnectorLevel(account.ID) != store.ConnectorAccessLevelWrite {
		levels := []store.ConnectorAccountPermission{}
		for _, existing := range pkg.ConnectorAccounts {
			if existing.AccountID != account.ID {
				levels = append(levels, existing)
			}
		}
		pkg.ConnectorAccounts = append(levels, store.ConnectorAccountPermission{AccountID: account.ID, Level: store.ConnectorAccessLevelWrite})
		if _, err := s.store.SavePermissionPackage(ctx, permission.Normalize(pkg)); err != nil {
			writeResult(w, nil, err)
			return
		}
	}
	if s.messageChannels != nil {
		s.messageChannels.Kick()
	}
	prerequisites, err := s.messageChannelPrerequisites(ctx, agent, account.ID)
	writeResult(w, prerequisites, err)
}

func (s *Server) messageChannelOf(w http.ResponseWriter, r *http.Request) (store.PersonalAgent, store.MessageChannelRecord, store.MessageChannelStore, bool) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return agent, store.MessageChannelRecord{}, nil, false
	}
	st, err := s.messageChannelStore()
	if err != nil {
		writeResult(w, nil, err)
		return agent, store.MessageChannelRecord{}, nil, false
	}
	record, err := st.GetMessageChannel(r.Context(), r.PathValue("channel"))
	if err != nil || record.UserID != agent.UserID || record.AssistantID != agent.ID {
		writeError(w, http.StatusNotFound, "not found")
		return agent, record, st, false
	}
	return agent, record, st, true
}

func (s *Server) messageChannelView(ctx context.Context, agent store.PersonalAgent, record store.MessageChannelRecord) (store.MessageChannelView, error) {
	st, err := s.messageChannelStore()
	if err != nil {
		return store.MessageChannelView{}, err
	}
	view := store.MessageChannelView{Channel: record.MessageChannel}
	runtime, err := st.GetMessageChannelRuntime(ctx, record.ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return view, err
	}
	view.Status = store.MessageChannelStatus{
		State: runtime.State, Detail: runtime.Detail, LastPollAt: runtime.LastPollAt, LastEventAt: runtime.LastEventAt,
		LastErrorAt: runtime.LastErrorAt, GapAt: runtime.GapAt,
	}
	if !record.Enabled {
		view.Status.State = channels.StatePaused
	} else if view.Status.State == "" {
		view.Status.State = channels.StateStarting
	}
	view.Status.Counts, err = st.CountMessageChannelDeliveries(ctx, record.ID, time.Now().Add(-24*time.Hour).UTC().Format(time.RFC3339Nano))
	if err != nil {
		return view, err
	}
	view.Prerequisites, err = s.messageChannelPrerequisites(ctx, agent, record.Source.AccountID)
	if err != nil {
		return view, err
	}
	view.Workspace = s.messageChannelWorkspaceView(ctx, record)
	view.SessionIDs, err = st.MessageChannelSessions(ctx, agent.ID, record.ID)
	return view, err
}

// messageChannelPrerequisites says whether the assistant's permission
// package lets it use the account and whether its home has it bound.
func (s *Server) messageChannelPrerequisites(ctx context.Context, agent store.PersonalAgent, accountID string) (store.MessageChannelPrerequisites, error) {
	pkg, err := s.store.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil {
		return store.MessageChannelPrerequisites{}, err
	}
	level := permission.Access{Applicable: true, Agent: agent, Package: pkg}.ConnectorLevel(accountID)
	bound, err := s.messageChannelSourceBound(ctx, agent, accountID)
	return store.MessageChannelPrerequisites{Allowed: level != store.ConnectorAccessLevelOff, Bound: bound, Level: level}, err
}

func (s *Server) messageChannelSourceBound(ctx context.Context, agent store.PersonalAgent, accountID string) (bool, error) {
	bindings, err := s.store.ListWorkspaceExternalAccounts(ctx, agent.WorkspaceID)
	if err != nil {
		return false, err
	}
	for _, binding := range bindings {
		if binding.AccountID == accountID {
			return true, nil
		}
	}
	return false, nil
}

// messageChannelSources are the person's connector extension instances
// whose descriptor declares an event feed.
func (s *Server) messageChannelSources(ctx context.Context, userID string) ([]store.MessageChannelSource, error) {
	sources := []store.MessageChannelSource{}
	if s.connectors == nil || s.connectors.ServerHeld == nil {
		return sources, nil
	}
	accounts, err := s.connectors.ServerHeld.AccountsIncludingExtensions(ctx, userID)
	if err != nil {
		return nil, err
	}
	for _, account := range accounts {
		app, data, err := s.messageChannelInstance(ctx, userID, account)
		if err != nil {
			continue
		}
		spec, _ := s.messageChannelFeed(ctx, userID, app, data)
		if spec == nil {
			continue
		}
		capabilities := channels.Capabilities(spec.Envelope)
		sources = append(sources, store.MessageChannelSource{Kind: account.Provider, AccountID: account.ID, InstanceID: app.ID, Label: app.Label, Capabilities: &capabilities})
	}
	return sources, nil
}

func (s *Server) messageChannelAccount(ctx context.Context, userID, accountID string) (store.ExternalAccount, error) {
	account, err := s.store.GetExternalAccount(ctx, strings.TrimSpace(accountID))
	if err != nil || account.OwnerUserID != userID {
		return store.ExternalAccount{}, &statusError{http.StatusBadRequest, errors.New("the source is not one of your connector accounts")}
	}
	return account, nil
}

func (s *Server) messageChannelInstance(ctx context.Context, userID string, account store.ExternalAccount) (store.ExternalProviderApp, store.ExtensionInstanceData, error) {
	app, err := s.store.GetExternalProviderApp(ctx, account.AppID)
	if err != nil || app.OwnerUserID != userID || app.CreatedVia != "extension" {
		return app, store.ExtensionInstanceData{}, channels.ErrUnsupported
	}
	data, err := s.connectors.ServerHeld.ExtensionData(ctx, app)
	return app, data, err
}

// messageChannelFeed is the instance's event feed: from the descriptor the
// person's devices report now, else the one the instance was validated with.
func (s *Server) messageChannelFeed(ctx context.Context, userID string, app store.ExternalProviderApp, data store.ExtensionInstanceData) (*store.ConnectorEventsSpec, store.ConnectorDescriptor) {
	kind := data.Descriptor.Kind
	if kind == "" {
		kind = app.Provider
	}
	if s.connectors != nil && s.connectors.Devices != nil {
		candidates := []string{data.ProbeDeviceID}
		if devices, err := s.ownDevices(ctx, userID); err == nil {
			for _, device := range devices {
				candidates = append(candidates, device.ID)
			}
		}
		for _, deviceID := range candidates {
			if deviceID == "" {
				continue
			}
			descriptor, err := s.connectors.Devices.ServerHeldDescriptorOn(ctx, deviceID, kind)
			if err == nil && descriptor.ServerHeld != nil && descriptor.ServerHeld.Events != nil {
				return descriptor.ServerHeld.Events, descriptor
			}
		}
	}
	if data.Descriptor.ServerHeld != nil && data.Descriptor.ServerHeld.Events != nil {
		return data.Descriptor.ServerHeld.Events, data.Descriptor
	}
	return nil, data.Descriptor
}

func (s *Server) cleanMessageChannelInput(ctx context.Context, r *http.Request, agent store.PersonalAgent, input store.MessageChannelInput) (store.MessageChannel, error) {
	bad := func(format string, args ...any) error {
		return &statusError{http.StatusBadRequest, fmt.Errorf(format, args...)}
	}
	var channel store.MessageChannel
	channel.Name = strings.Join(strings.Fields(input.Name), " ")
	if channel.Name == "" || utf8.RuneCountInString(channel.Name) > 80 {
		return channel, bad("name is 1 to 80 characters")
	}
	channel.Enabled = input.Enabled
	account, err := s.messageChannelAccount(ctx, agent.UserID, input.Source.AccountID)
	if err != nil {
		return channel, err
	}
	app, data, err := s.messageChannelInstance(ctx, agent.UserID, account)
	if err != nil {
		return channel, bad("the source must be a connector extension instance")
	}
	if spec, _ := s.messageChannelFeed(ctx, agent.UserID, app, data); spec == nil {
		return channel, bad("this connector declares no event feed")
	}
	channel.Source = store.MessageChannelSource{Kind: account.Provider, AccountID: account.ID, InstanceID: app.ID, Label: app.Label}
	if len(input.Filters.Rules) > 20 {
		return channel, bad("a channel has at most 20 rules")
	}
	channel.Filters.Rules = []store.MessageChannelRule{}
	for i, rule := range input.Filters.Rules {
		if rule.ID == "" {
			rule.ID = fmt.Sprintf("rule-%d", i+1)
		}
		rule.Label = strings.TrimSpace(rule.Label)
		if len(rule.ID) > 64 || utf8.RuneCountInString(rule.Label) > 80 {
			return channel, bad("rule %d: id or label is too long", i+1)
		}
		kinds := []string{}
		for _, kind := range rule.ConversationKinds {
			if !slices.Contains([]string{"direct", "group", "channel", "feed", "other"}, kind) {
				return channel, bad("rule %d: unknown conversation kind %q", i+1, kind)
			}
			kinds = append(kinds, kind)
		}
		rule.ConversationKinds = kinds
		for _, tri := range []*string{&rule.MentionsMe, &rule.FromSelf} {
			if *tri == "" {
				*tri = "any"
			}
			if !slices.Contains([]string{"any", "yes", "no"}, *tri) {
				return channel, bad("rule %d: mentionsMe and fromSelf are any, yes or no", i+1)
			}
		}
		prefixes := []string{}
		for _, prefix := range rule.TextPrefixes {
			if prefix = strings.TrimSpace(prefix); prefix != "" {
				if utf8.RuneCountInString(prefix) > 40 {
					return channel, bad("rule %d: a prefix is at most 40 characters", i+1)
				}
				prefixes = append(prefixes, prefix)
			}
		}
		if len(prefixes) > 10 {
			return channel, bad("rule %d: at most 10 prefixes", i+1)
		}
		rule.TextPrefixes = prefixes
		for _, list := range []*[]string{&rule.ConversationIDs, &rule.ExcludeConversationIDs, &rule.SenderIDs, &rule.ExcludeSenderIDs} {
			*list = cleanIDList(*list)
			if len(*list) > 100 {
				return channel, bad("rule %d: at most 100 ids per list", i+1)
			}
		}
		channel.Filters.Rules = append(channel.Filters.Rules, rule)
	}
	channel.Guide = strings.TrimSpace(input.Guide)
	if utf8.RuneCountInString(channel.Guide) > channels.MaxGuide {
		return channel, bad("the guide is at most %d characters", channels.MaxGuide)
	}
	channel.SessionKey = input.SessionKey
	if channel.SessionKey == "" {
		channel.SessionKey = "thread"
	}
	if channel.SessionKey != "conversation" && channel.SessionKey != "thread" {
		return channel, bad("sessionKey is conversation or thread")
	}
	rule := channels.SessionRule(store.MessageChannel{Session: input.Session})
	if !slices.Contains([]int{0, 30, 60, 240, 720, 1440, 4320, 10080}, rule.IdleMinutes) {
		return channel, bad("session.idleMinutes is 0 (never), 30, 60, 240, 720, 1440, 4320 or 10080")
	}
	commands := []string{}
	for _, command := range rule.ResetCommands {
		if command = strings.TrimSpace(command); command != "" && !slices.Contains(commands, command) {
			if utf8.RuneCountInString(command) > 40 || strings.ContainsFunc(command, unicode.IsSpace) {
				return channel, bad("a new-session command is one word of at most 40 characters")
			}
			commands = append(commands, command)
		}
	}
	if len(commands) > 5 {
		return channel, bad("at most 5 new-session commands")
	}
	channel.Session = &store.MessageChannelSessionRule{IdleMinutes: rule.IdleMinutes, ResetCommands: commands}
	channel.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	scope := input.Scope
	if scope.ConnectorDefault == "" {
		scope.ConnectorDefault = "inherit"
	}
	if scope.ConnectorDefault != "inherit" && scope.ConnectorDefault != store.ConnectorAccessLevelOff {
		return channel, bad("scope.connectorDefault is inherit or off")
	}
	if len(scope.Connectors) > 50 {
		return channel, bad("scope lists at most 50 connector accounts")
	}
	connectors := []store.MessageChannelConnectorScope{}
	seen := map[string]bool{}
	for _, connector := range scope.Connectors {
		connector.AccountID = strings.TrimSpace(connector.AccountID)
		if connector.AccountID == "" || seen[connector.AccountID] {
			continue
		}
		seen[connector.AccountID] = true
		if !slices.Contains([]string{store.ConnectorAccessLevelOff, store.ConnectorAccessLevelRead, store.ConnectorAccessLevelWrite}, connector.Level) {
			return channel, bad("a connector's level is off, read or write")
		}
		if connector.Writes == "" {
			connector.Writes = "confirm"
		}
		if connector.Writes != "confirm" && connector.Writes != "direct" {
			return channel, bad("a connector's writes are confirm or direct")
		}
		connectors = append(connectors, connector)
	}
	scope.Connectors = connectors
	if scope.Workspaces.Scope == "" {
		scope.Workspaces.Scope = store.PermissionListScopeAll
	}
	scope.Workspaces.Include, scope.Workspaces.Exclude = cleanIDList(scope.Workspaces.Include), cleanIDList(scope.Workspaces.Exclude)
	scope.IdentityResources = cleanIDList(scope.IdentityResources)
	if len(scope.Workspaces.Include)+len(scope.Workspaces.Exclude) > 200 || len(scope.IdentityResources) > 50 {
		return channel, bad("scope lists too many workspaces or resources")
	}
	probe := store.PermissionPackage{Owner: agent.UserID, Workspaces: scope.Workspaces}
	probe.IdentityResources.Allowed = scope.IdentityResources
	if invalidWorkspaces, invalidResources, err := s.invalidPermissionPackageReferences(ctx, r, probe); err != nil {
		return channel, err
	} else if len(invalidWorkspaces)+len(invalidResources) > 0 {
		return channel, bad("scope names workspaces or resources you cannot reach")
	}
	channel.Scope = scope
	limits := input.Limits
	if limits.PerHour == 0 {
		limits.PerHour = channels.DefaultPerHour
	}
	if limits.PerDay == 0 {
		limits.PerDay = channels.DefaultPerDay
	}
	if limits.Concurrency == 0 {
		limits.Concurrency = channels.DefaultConcurrency
	}
	if limits.PerHour < 1 || limits.PerHour > 1000 || limits.PerDay < 1 || limits.PerDay > 10000 || limits.Concurrency < 1 || limits.Concurrency > 10 {
		return channel, bad("limits: perHour 1–1000, perDay 1–10000, concurrency 1–10")
	}
	channel.Limits = limits
	return channel, nil
}

func cleanIDList(ids []string) []string {
	out := []string{}
	for _, id := range ids {
		if id = strings.TrimSpace(id); id != "" && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

// messageChannelActions are what each delivery's session did afterwards
// through the channel's source account (the gateway's audit) and the items
// it handed to the person, by delivery id.
func (s *Server) messageChannelActions(ctx context.Context, agent store.PersonalAgent, channel store.MessageChannelRecord, records []store.MessageChannelDeliveryRecord) map[string][]store.MessageChannelAction {
	out := map[string][]store.MessageChannelAction{}
	bySession := map[string][]store.MessageChannelDeliveryRecord{}
	for _, record := range records {
		if record.SessionID != "" && record.DeliveredAt != "" {
			bySession[record.SessionID] = append(bySession[record.SessionID], record)
		}
	}
	if len(bySession) == 0 {
		return out
	}
	// The delivery an action belongs to: the latest one of its session
	// delivered before it.
	owner := func(sessionID, at string) string {
		id, latest := "", ""
		for _, record := range bySession[sessionID] {
			if record.DeliveredAt <= at && record.DeliveredAt >= latest {
				id, latest = record.ID, record.DeliveredAt
			}
		}
		return id
	}
	events, _ := s.store.ListExternalAccountEvents(ctx, channel.Source.AccountID, 500)
	for _, event := range events {
		if event.Kind != "extension_connector_request" || bySession[event.SessionID] == nil {
			continue
		}
		detail := extensionRequestSummary(event.Detail)
		if !detail.write && detail.outcome != "refused" {
			continue
		}
		id := owner(event.SessionID, event.CreatedAt)
		if id == "" {
			continue
		}
		kind := "connector_write"
		if detail.outcome == "refused" {
			kind = "connector_refused"
		}
		out[id] = append(out[id], store.MessageChannelAction{At: event.CreatedAt, Kind: kind, Summary: detail.text})
	}
	sessionIDs := make([]string, 0, len(bySession))
	for id := range bySession {
		sessionIDs = append(sessionIDs, id)
	}
	if st, ok := s.store.(store.MessageChannelStore); ok {
		refused, _ := st.MessageChannelSessionEvents(ctx, sessionIDs, "Workspace write refused", 200)
		for _, event := range refused {
			if id := owner(event.SessionID, event.At); id != "" {
				out[id] = append(out[id], store.MessageChannelAction{At: event.At, Kind: "workspace_write_refused", Summary: event.Detail})
			}
		}
	}
	items, _ := s.store.ListPendingItems(ctx, agent.UserID, []string{store.PendingOpen, store.PendingReplied, store.PendingDone, store.PendingDismissed, store.PendingSuperseded}, "", 300)
	for _, item := range items {
		if bySession[item.SessionID] == nil {
			continue
		}
		if id := owner(item.SessionID, item.CreatedAt); id != "" {
			out[id] = append(out[id], store.MessageChannelAction{At: item.CreatedAt, Kind: "needs_you", Summary: item.Title})
		}
	}
	for id := range out {
		slices.SortFunc(out[id], func(a, b store.MessageChannelAction) int { return strings.Compare(a.At, b.At) })
	}
	return out
}

type extensionRequestLine struct {
	write   bool
	outcome string
	text    string
}

func extensionRequestSummary(raw string) extensionRequestLine {
	var detail struct {
		Method  string `json:"method"`
		Route   string `json:"route"`
		Status  int    `json:"status"`
		Outcome string `json:"outcome"`
		Write   bool   `json:"write"`
		Error   string `json:"error"`
	}
	_ = decodeJSON(strings.NewReader(raw), &detail, false)
	text := strings.TrimSpace(detail.Method + " " + detail.Route)
	if detail.Status != 0 {
		text += fmt.Sprintf(" → %d", detail.Status)
	}
	if detail.Error != "" {
		text += " (" + detail.Error + ")"
	}
	return extensionRequestLine{write: detail.Write, outcome: detail.Outcome, text: text}
}

// --- the runner's ports ---

func (s *Server) messageChannelSourceLabel(ctx context.Context, channel store.MessageChannelRecord) string {
	label := channel.Source.Label
	if label == "" {
		label = channel.Source.Kind
	}
	return label
}

// tellAboutMessageChannel puts an item for the person in needs-you, once
// per channel and key while it is open.
func (s *Server) tellAboutMessageChannel(ctx context.Context, channel store.MessageChannelRecord, key, title, detail string) {
	agent, err := s.store.GetAssistant(ctx, channel.AssistantID)
	if err != nil {
		return
	}
	_, _, err = s.store.RecordPendingItem(ctx, store.PendingItem{
		UserID: channel.UserID, AssistantID: agent.ID, WorkspaceID: agent.WorkspaceID,
		Source: store.PendingSourceMessageChannel, Key: "message-channel:" + channel.ID + ":" + key,
		Title: title, Excerpt: detail, Handler: store.PendingHandlerPerson,
	})
	if err != nil && ctx.Err() == nil {
		s.connectors.ServerHeld.Logf("message channel %s: needs-you item: %v", channel.ID, err)
	}
}

// messageChannelInbox carries a channel's turns through the assistant inbox.
type messageChannelInbox struct{ s *Server }

func (i messageChannelInbox) Deliver(ctx context.Context, channel store.MessageChannelRecord, turn channels.Turn) (string, error) {
	agent, err := i.s.store.GetAssistant(ctx, channel.AssistantID)
	if err != nil {
		return "", err
	}
	entry, err := i.s.assistant.CaptureInbox(ctx, agent, turn.InboxChannel,
		store.PersonalAgentInboxCapture{MessageID: turn.MessageID, Text: turn.Text})
	return entry.ID, err
}

func (i messageChannelInbox) Status(ctx context.Context, assistantID, inboxID string) (channels.InboxStatus, error) {
	entry, err := i.s.store.GetPersonalAgentInbox(ctx, assistantID, inboxID)
	if err != nil {
		return channels.InboxStatus{}, err
	}
	return channels.InboxStatus{Status: entry.Status, WaitingReason: entry.WaitingReason, SessionID: entry.SessionID, ResultStatus: entry.ResultStatus}, nil
}

// channelSessionOfAssistant reports whether sessionID is a message channel
// session of the assistant (its hand_over goes straight to the person).
func (s *Server) channelSessionOfAssistant(ctx context.Context, agent store.PersonalAgent, sessionID string) bool {
	st, ok := s.store.(store.MessageChannelStore)
	if !ok || sessionID == "" {
		return false
	}
	channel, err := st.MessageChannelOfSession(ctx, sessionID)
	return err == nil && channel.AssistantID == agent.ID && channel.UserID == agent.UserID
}

// pruneMessageChannels drops records of filtered-out messages after a day
// and the text of the others after 30 days.
func (s *Server) pruneMessageChannels(ctx context.Context) {
	st, ok := s.store.(store.MessageChannelStore)
	if !ok {
		return
	}
	now := time.Now().UTC()
	if err := st.PruneMessageChannelDeliveries(ctx, now.Add(-24*time.Hour).Format(time.RFC3339Nano), now.Add(-30*24*time.Hour).Format(time.RFC3339Nano)); err != nil && ctx.Err() == nil {
		s.connectors.ServerHeld.Logf("message channels: prune: %v", err)
	}
}

// handleTestMessageChannelRules tries rules before they are saved, with the
// channel's own matcher: on samples the person makes up, and on the
// source's recent messages the person's channels saw (filtered-out ones
// keep only their opening).
func (s *Server) handleTestMessageChannelRules(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input store.MessageChannelTestInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if len(input.Filters.Rules) > 20 || len(input.Samples) > 20 {
		writeError(w, http.StatusBadRequest, "at most 20 rules and 20 samples")
		return
	}
	result := store.MessageChannelTestResult{Verdicts: []store.MessageChannelVerdict{}}
	verdict := func(envelope store.MessageEnvelope) store.MessageChannelVerdict {
		decision, checks := channels.Explain(input.Filters.Rules, envelope)
		out := store.MessageChannelVerdict{Envelope: envelope, Keep: decision.Keep, Rule: decision.Rule, Checks: []store.MessageChannelRuleCheck{}}
		for _, check := range checks {
			out.Checks = append(out.Checks, store.MessageChannelRuleCheck{RuleID: check.RuleID, Miss: check.Miss})
		}
		return out
	}
	for i, sample := range input.Samples {
		envelope := store.MessageEnvelope{ID: fmt.Sprintf("sample-%d", i), Kind: "message", Op: "new", Text: sample.Text,
			Conversation: store.MessageEnvelopeConversation{ID: sample.ConversationID, Kind: sample.ConversationKind},
			Sender:       store.MessageEnvelopeSender{ID: sample.SenderID, IsSelf: sample.FromSelf}, MentionsMe: sample.MentionsMe}
		item := verdict(envelope)
		index := i
		item.Sample = &index
		result.Verdicts = append(result.Verdicts, item)
	}
	if input.Recent && input.SourceAccountID != "" {
		recent, err := s.recentMessageChannelEnvelopes(r.Context(), agent.UserID, input.SourceAccountID, 30)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		for _, envelope := range recent {
			if envelope.Text != "" {
				result.Verdicts = append(result.Verdicts, verdict(envelope))
				continue
			}
			// A filtered-out message keeps no text: check everything but
			// the trigger words, and say so.
			rules := make([]store.MessageChannelRule, len(input.Filters.Rules))
			for i, rule := range input.Filters.Rules {
				rule.TextPrefixes = nil
				rules[i] = rule
			}
			decision, checks := channels.Explain(rules, envelope)
			item := store.MessageChannelVerdict{Envelope: envelope, Keep: decision.Keep, Rule: decision.Rule, TextUnknown: true, Checks: []store.MessageChannelRuleCheck{}}
			for _, check := range checks {
				item.Checks = append(item.Checks, store.MessageChannelRuleCheck{RuleID: check.RuleID, Miss: check.Miss})
			}
			result.Verdicts = append(result.Verdicts, item)
		}
	}
	writeJSON(w, http.StatusOK, result)
}

// handleMessageChannelPeers lists the conversations and senders the
// person's channels saw recently from a source, for picking them by name.
func (s *Server) handleMessageChannelPeers(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	recent, err := s.recentMessageChannelEnvelopes(r.Context(), agent.UserID, r.URL.Query().Get("accountId"), 500)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	peers := store.MessageChannelPeers{Conversations: []store.MessageChannelPeer{}, Senders: []store.MessageChannelPeer{}}
	conversations, senders := map[string]int{}, map[string]int{}
	add := func(list *jsonempty.List[store.MessageChannelPeer], index map[string]int, peer store.MessageChannelPeer) {
		if peer.ID == "" {
			return
		}
		if i, ok := index[peer.ID]; ok {
			(*list)[i].Count++
			if (*list)[i].Name == "" {
				(*list)[i].Name = peer.Name
			}
			return
		}
		index[peer.ID] = len(*list)
		*list = append(*list, peer)
	}
	for _, envelope := range recent {
		add(&peers.Conversations, conversations, store.MessageChannelPeer{ID: envelope.Conversation.ID, Name: envelope.Conversation.Name,
			ConversationKind: envelope.Conversation.Kind, Count: 1, LastSeenAt: envelope.OccurredAt})
		add(&peers.Senders, senders, store.MessageChannelPeer{ID: envelope.Sender.ID, Name: envelope.Sender.Name, Count: 1, LastSeenAt: envelope.OccurredAt})
	}
	writeJSON(w, http.StatusOK, peers)
}

// recentMessageChannelEnvelopes are the newest messages, at most limit and
// each once, that any of the person's channels on this source account saw.
func (s *Server) recentMessageChannelEnvelopes(ctx context.Context, userID, accountID string, limit int) ([]store.MessageEnvelope, error) {
	st, err := s.messageChannelStore()
	if err != nil {
		return nil, err
	}
	records, err := st.ListMessageChannels(ctx, userID, "")
	if err != nil {
		return nil, err
	}
	var all []store.MessageChannelDeliveryRecord
	for _, record := range records {
		if record.Source.AccountID != accountID {
			continue
		}
		deliveries, err := st.ListMessageChannelDeliveries(ctx, record.ID, nil, limit)
		if err != nil {
			return nil, err
		}
		all = append(all, deliveries...)
	}
	slices.SortFunc(all, func(a, b store.MessageChannelDeliveryRecord) int { return strings.Compare(b.CreatedAt, a.CreatedAt) })
	seen := map[string]bool{}
	out := []store.MessageEnvelope{}
	for _, record := range all {
		if seen[record.Envelope.ID] || len(out) >= limit {
			continue
		}
		seen[record.Envelope.ID] = true
		out = append(out, record.Envelope)
	}
	return out, nil
}
