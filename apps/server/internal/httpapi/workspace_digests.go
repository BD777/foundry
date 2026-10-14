package httpapi

import (
	"context"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/workspacedigest"
)

// What the Personal Agent knows of a person's projects and devices
// (docs/personal-agent.md §3): workspacedigest keeps and ranks the digests;
// here they are fed. Only people with an assistant have digests. Every read
// (find_workspace, get_workspace, the L0 index) first brings the person's
// digests up to date with the store, so renames, archives, devices coming
// and going and lost memberships show at once; the observers below refresh
// a workspace's digests when its sessions end or its Issues change, and run
// the summaries that fell due, each a read-only session with source
// "digest" in the person's assistant workspace.

// workspaceDigests is the digest service; the assistant's tools call its
// Find, Digest, Index and Devices with the person's id.
func (s *Server) workspaceDigests() *workspacedigest.Service {
	service := workspacedigest.New(s.store, digestSources{s})
	service.Wake = s.wakeDigestSummaries
	return service
}

// observeWorkspaceDigests follows what changes digests: sessions ending,
// Issues changing, devices connecting (their workspaces' files and
// online state, and the assistant's home device coming back to run due
// summaries).
func (s *Server) observeWorkspaceDigests(sessions *sessionEvents, issues *issueEvents) {
	reactions := workspaceDigestReactions{s}
	sessions.observe(reactions)
	issues.observe(reactions)
	connected := s.hub.onDeviceConnected
	s.hub.onDeviceConnected = func(ctx context.Context, deviceID string, capabilities []string) {
		if connected != nil {
			connected(ctx, deviceID, capabilities)
		}
		reactions.deviceConnected(ctx, deviceID)
	}
}

// refreshWorkspaceDigests brings everyone's digest of a workspace up to
// date. Reads do so anyway; a writer that wants the change in the next
// summary's schedule at once (a rename, a skill or connector change) may
// call it.
func (s *Server) refreshWorkspaceDigests(ctx context.Context, workspaceID string) {
	if strings.TrimSpace(workspaceID) == "" {
		return
	}
	if err := s.workspaceDigests().Refresh(ctx, workspaceID); err != nil && !errors.Is(err, store.ErrNotFound) {
		log.Printf("refresh digests of %s: %v", workspaceID, err)
	}
}

type workspaceDigestReactions struct{ s *Server }

// sessionChanged refreshes the digests of a workspace whose session ended
// and takes a summary session's answer.
func (r workspaceDigestReactions) sessionChanged(ctx context.Context, change sessionChange, session store.AgentSession) {
	if change != sessionCompleted {
		return
	}
	if session.Source == store.DigestSessionSource {
		r.s.finishDigestSummary(ctx, session)
		return
	}
	r.s.refreshWorkspaceDigests(ctx, session.WorkspaceID)
}

func (r workspaceDigestReactions) issueUpdated(issue store.Issue) {
	r.s.refreshWorkspaceDigests(context.Background(), issue.WorkspaceID)
}

// deviceConnected refreshes the digests of the device's workspaces, reads
// the instruction files whose intro is out of date, and runs the
// summaries that waited for it.
func (r workspaceDigestReactions) deviceConnected(ctx context.Context, deviceID string) {
	workspaces, err := r.s.store.ListWorkspaces(ctx)
	if err != nil {
		return
	}
	service := r.s.workspaceDigests()
	for _, workspace := range workspaces {
		if workspace.DeviceID != deviceID {
			continue
		}
		r.s.refreshWorkspaceDigests(ctx, workspace.ID)
		if filesRev, wanted, err := service.IntroWanted(ctx, workspace.ID); err == nil && wanted {
			if excerpts := r.s.readInstructionFiles(ctx, workspace); len(excerpts) > 0 {
				if err := service.SetIntro(ctx, workspace.ID, filesRev, excerpts[0].Content); err != nil {
					log.Printf("save intro of %s: %v", workspace.ID, err)
				}
			}
		}
	}
	// What waited for an assistant's device runs now it is back.
	r.s.runDigestSummaries(ctx, digestRetryOffline)
}

// digestSources reads what digests are compiled from, as the person may
// read it.
type digestSources struct{ s *Server }

// Readable lists the workspaces the person is a member of: digests follow
// membership, the same as what an agent acting for them reaches. An
// assistant's own workspace has none.
func (d digestSources) Readable(ctx context.Context, userID string) ([]workspacedigest.Access, error) {
	roles, err := d.s.store.WorkspaceRolesForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	workspaces, err := d.s.store.ListWorkspaces(ctx)
	if err != nil {
		return nil, err
	}
	accesses := []workspacedigest.Access{}
	for _, workspace := range workspaces {
		if role := roles[workspace.ID]; role != "" && workspace.Kind != store.WorkspaceKindPersonalAgent {
			accesses = append(accesses, workspacedigest.Access{UserID: userID, WorkspaceID: workspace.ID, Role: role})
		}
	}
	return accesses, nil
}

// Readers lists the workspace's members who have an assistant.
func (d digestSources) Readers(ctx context.Context, workspaceID string) ([]workspacedigest.Access, error) {
	workspace, err := d.s.store.GetWorkspace(ctx, workspaceID)
	if err != nil || workspace.Kind == store.WorkspaceKindPersonalAgent {
		return nil, err
	}
	members, err := d.s.store.ListWorkspaceMembers(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	readers := []workspacedigest.Access{}
	for _, member := range members {
		if _, err := d.s.store.GetPersonalAgent(ctx, member.UserID); err == nil {
			readers = append(readers, workspacedigest.Access{UserID: member.UserID, WorkspaceID: workspaceID, Role: member.Role})
		} else if !errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
	}
	return readers, nil
}

func (d digestSources) Collect(ctx context.Context, access workspacedigest.Access) (workspacedigest.Source, error) {
	s, workspaceID := d.s, access.WorkspaceID
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return workspacedigest.Source{}, err
	}
	source := workspacedigest.Source{Workspace: workspace, DeviceOnline: workspace.DeviceID != "" && s.hub.HasConnection(workspace.DeviceID)}
	if source.Purpose, err = s.store.WorkspacePurpose(ctx, workspaceID); err != nil && !errors.Is(err, store.ErrNotFound) {
		return source, err
	}
	if source.Sessions, err = s.store.ListAgentSessionSummaries(ctx, workspaceID); err != nil {
		return source, err
	}
	if source.Chats, err = s.store.ListChats(ctx, workspaceID); err != nil {
		return source, err
	}
	titles, err := s.store.ListChatTitles(ctx, workspaceID)
	if err != nil {
		return source, err
	}
	named := map[string]string{}
	for _, title := range titles {
		named[title.ChatID] = title.Title
	}
	for i, chat := range source.Chats {
		if title := strings.TrimSpace(named[chat.ID]); title != "" {
			source.Chats[i].Title = title
		}
	}
	for i, session := range source.Sessions {
		if title := strings.TrimSpace(named[session.ID]); title != "" {
			source.Sessions[i].Title = title
		}
	}
	if source.Issues, err = s.store.ListIssues(ctx, workspaceID); err != nil {
		return source, err
	}
	if source.Files, err = s.store.ListWorkspaceFiles(ctx, workspaceID); err != nil {
		return source, err
	}
	reported, err := s.store.ListSkills(ctx, workspaceID)
	if err != nil {
		return source, err
	}
	for _, skill := range reported {
		source.Skills = append(source.Skills, skill.Name)
	}
	selected, err := s.store.ResolveSessionSkills(ctx, workspaceID)
	if err != nil {
		return source, err
	}
	for _, skill := range selected {
		source.Skills = append(source.Skills, skill.Name)
	}
	source.Connectors, err = d.connectors(ctx, workspaceID)
	return source, err
}

// connectors names the logins the workspace's sessions may use: the
// device-held connectors bound there and the accounts bound to it.
func (d digestSources) connectors(ctx context.Context, workspaceID string) ([]string, error) {
	names := []string{}
	name := func(kind string) string {
		if descriptor, ok := d.s.connectors.Lookup(kind); ok && descriptor.Label != "" {
			return descriptor.Label
		}
		return kind
	}
	bindings, err := d.s.connectors.Devices.Bindings(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	for _, binding := range bindings {
		names = append(names, name(binding.Kind))
	}
	accounts, err := d.s.store.ListWorkspaceExternalAccounts(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	for _, binding := range accounts {
		account, err := d.s.store.GetExternalAccount(ctx, binding.AccountID)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		names = append(names, name(account.Provider))
	}
	return names, nil
}

func (d digestSources) Devices(ctx context.Context, userID string) ([]workspacedigest.DeviceSource, error) {
	s := d.s
	owned, err := s.store.DevicesOwnedBy(ctx, userID)
	if err != nil {
		return nil, err
	}
	ownedSet := map[string]bool{}
	for _, id := range owned {
		ownedSet[id] = true
	}
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return nil, err
	}
	workspaces, err := s.store.ListWorkspaces(ctx)
	if err != nil {
		return nil, err
	}
	profiles, err := s.store.ListProfiles(ctx)
	if err != nil {
		return nil, err
	}
	profileLabels := map[string]string{}
	for _, profile := range profiles {
		profileLabels[profile.ID] = profile.Label
	}
	sources := []workspacedigest.DeviceSource{}
	for _, device := range devices {
		if !ownedSet[device.ID] {
			continue
		}
		source := workspacedigest.DeviceSource{Device: device, Online: s.hub.HasConnection(device.ID)}
		if source.Providers, err = s.store.ListProviderHealth(ctx, device.ID); err != nil {
			return nil, err
		}
		bindings, err := s.store.ListDeviceProfiles(ctx, device.ID)
		if err != nil {
			return nil, err
		}
		for _, binding := range bindings {
			if label := profileLabels[binding.ProfileID]; binding.Enabled && label != "" {
				source.ModelServices = append(source.ModelServices, label)
			}
		}
		for _, workspace := range workspaces {
			if workspace.DeviceID == device.ID && workspace.Kind != store.WorkspaceKindPersonalAgent {
				source.WorkspaceCount++
			}
		}
		sources = append(sources, source)
	}
	return sources, nil
}

// How the summaries run.
const (
	// digestDueBatch is how many due summaries one run starts at most.
	digestDueBatch = 20
	// digestRetryAway: a summary waiting for its person's assistant (none,
	// stopped) is looked at again after this.
	digestRetryAway = personalagent.DigestMinInterval
	// digestRetryOffline: one waiting for the assistant's device or its
	// hourly rate.
	digestRetryOffline = 10 * time.Minute
	// digestFileReadTimeout bounds reading a project's instruction files.
	digestFileReadTimeout = 10 * time.Second
	// digestPrimeConcurrency is how many first summaries of one person's
	// projects run at once.
	digestPrimeConcurrency = 3
)

// errDigestBusy: the person's first summaries already run as many as
// they may; the next starts when one of them ends.
var errDigestBusy = errors.New("as many first summaries run as may")

// digestDispatch runs one dispatch at a time: a summary is claimed only
// after its session exists.
var digestDispatch sync.Mutex

// wakeDigestSummaries runs the due summaries at at.
func (s *Server) wakeDigestSummaries(at time.Time) {
	time.AfterFunc(max(time.Until(at), 0)+time.Second, func() {
		s.runDigestSummaries(context.Background(), 0)
	})
}

// runDigestSummaries starts the summaries due within ahead, most recently
// active projects first, within each person's limits (§9 and §14: per
// day, and at most DigestMigrationRate an hour), on their assistant's
// home device. What cannot run now is postponed.
func (s *Server) runDigestSummaries(ctx context.Context, ahead time.Duration) {
	digestDispatch.Lock()
	defer digestDispatch.Unlock()
	service := s.workspaceDigests()
	// One wake for everything postponed, at the earliest.
	next := time.Time{}
	service.Wake = func(at time.Time) {
		if next.IsZero() || at.Before(next) {
			next = at
		}
	}
	due, err := service.Due(ctx, ahead, digestDueBatch)
	if err != nil {
		log.Printf("list due digest summaries: %v", err)
		return
	}
	busy := false
	for _, record := range due {
		err := s.startDigestSummary(ctx, service, record)
		switch {
		case errors.Is(err, errDigestBusy):
			busy = true
		case err != nil:
			log.Printf("summary of %s for %s: %v", record.Digest.WorkspaceID, record.Digest.UserID, err)
		}
	}
	// A full batch may hide more that are due; while first summaries wait
	// for a running one, its end runs this again instead.
	if len(due) == digestDueBatch && !busy {
		next = service.Now()
	}
	if !next.IsZero() {
		s.wakeDigestSummaries(next)
	}
}

func (s *Server) startDigestSummary(ctx context.Context, service *workspacedigest.Service, record store.WorkspaceDigestRecord) error {
	now := service.Now()
	agent, err := s.store.GetPersonalAgent(ctx, record.Digest.UserID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && agent.State != store.PersonalAgentActive) {
		return service.Postpone(ctx, record, now.Add(digestRetryAway))
	}
	if err != nil {
		return err
	}
	home := s.hub.connectionFor(agent.HomeDeviceID)
	// A worker that takes setup_workspace's create knows a digest session
	// is read-only and without Foundry tools; an older one would run it as
	// a chat.
	if home == nil || !s.hub.HasConnection(agent.HomeDeviceID) || !home.hasCapability(store.DaemonCapabilityWorkspaceCreate) {
		return service.Postpone(ctx, record, now.Add(digestRetryOffline))
	}
	if record.Digest.SummarizedAt == "" {
		// A project's first summary primes what the assistant knows (§14):
		// every one runs, a few at a time, outside the steady-state limits.
		running, err := s.runningDigestSummaries(ctx, agent.UserID)
		if err != nil {
			return err
		}
		if running >= digestPrimeConcurrency {
			return errDigestBusy
		}
	} else if err := s.digestSummaryAllowed(ctx, service, record, agent, now); err != nil {
		return err
	}
	prompt, err := s.digestSummaryPrompt(ctx, service, record, agent.Settings.Language)
	if err != nil {
		return err
	}
	input := store.CreateAgentSessionInput{
		CreatedByUserID:      agent.UserID,
		WorkspaceID:          agent.WorkspaceID,
		Source:               store.DigestSessionSource,
		ProfileID:            agent.Settings.AssistantProfileID,
		Model:                agent.Settings.AssistantModel,
		CodexSandboxMode:     "read-only",
		CodexApprovalPolicy:  "never",
		ClaudePermissionMode: "dontAsk",
		Prompt:               prompt,
	}
	if err := s.pickSessionDevice(ctx, &input, true); err != nil {
		return service.Postpone(ctx, record, now.Add(digestRetryOffline))
	}
	session, err := s.store.CreateAgentSession(ctx, input)
	if err != nil {
		return err
	}
	s.sessions.changed(ctx, sessionCreated, session)
	if claimed, err := service.Claim(ctx, record, session.ID); err != nil || !claimed {
		s.failUndelivered(ctx, session, "another summary of this project is running")
		return err
	}
	_, err = s.dispatchOrFail(ctx, session, notConnected)
	return err
}

// digestSummaryAllowed postpones a summary past the person's limits on
// refreshing summaries (§9: per day, and DigestMigrationRate an hour):
// errDigestPostponed when it did.
func (s *Server) digestSummaryAllowed(ctx context.Context, service *workspacedigest.Service, record store.WorkspaceDigestRecord, agent store.PersonalAgent, now time.Time) error {
	daily := agent.Settings.Limits.DailyDigestSessions
	if daily <= 0 {
		daily = personalagent.DefaultLimits.DailyDigestSessions
	}
	dayStart := startOfDay(now, agent.Settings.Timezone)
	if today, err := service.SummariesSince(ctx, agent.UserID, dayStart); err != nil {
		return err
	} else if today >= daily {
		return postponed(service.Postpone(ctx, record, dayStart.Add(24*time.Hour)))
	}
	if lastHour, err := service.SummariesSince(ctx, agent.UserID, now.Add(-time.Hour)); err != nil {
		return err
	} else if lastHour >= personalagent.DigestMigrationRate {
		return postponed(service.Postpone(ctx, record, now.Add(digestRetryOffline)))
	}
	return nil
}

// errDigestPostponed: the summary waits for later.
var errDigestPostponed = errors.New("postponed")

func postponed(err error) error {
	if err != nil {
		return err
	}
	return errDigestPostponed
}

// runningDigestSummaries counts the person's summary sessions running.
func (s *Server) runningDigestSummaries(ctx context.Context, userID string) (int, error) {
	records, err := s.store.ListWorkspaceDigests(ctx, userID)
	if err != nil {
		return 0, err
	}
	running := 0
	for _, record := range records {
		if record.SummarySessionID != "" {
			running++
		}
	}
	return running, nil
}

// primeAssistantDigests is setting up the assistant (§14): every project
// the person can read gets its digest now and its first summary soon.
func (s *Server) primeAssistantDigests(ctx context.Context, userID string) {
	if err := s.workspaceDigests().Prime(ctx, userID); err != nil {
		log.Printf("prime the digests of %s: %v", userID, err)
	}
}

// digestSummaryPrompt reads what a summary needs beyond the digest: the
// start of the project's instruction files, from its device when it is
// online, and what its latest sessions answered.
func (s *Server) digestSummaryPrompt(ctx context.Context, service *workspacedigest.Service, record store.WorkspaceDigestRecord, language string) (string, error) {
	digest := record.Digest
	input := workspacedigest.SummaryInput{Digest: digest, Language: language, Requests: record.History, Files: record.Files}
	if workspace, err := s.store.GetWorkspace(ctx, digest.WorkspaceID); err == nil && s.hub.HasConnection(workspace.DeviceID) {
		input.Instructions = s.readInstructionFiles(ctx, workspace)
		if record.NeedsIntro() && len(input.Instructions) > 0 {
			if err := service.SetIntro(ctx, digest.WorkspaceID, record.FilesRev, input.Instructions[0].Content); err != nil {
				return "", err
			}
			input.Digest.Intro = workspacedigest.FirstParagraph(input.Instructions[0].Content)
		}
	}
	for _, recent := range digest.RecentSessions {
		brief := workspacedigest.WorkBrief{Title: recent.Title, Status: recent.Status}
		if session, err := s.store.GetAgentSessionSummary(ctx, recent.ID); err == nil {
			brief.Answer = session.Response
		}
		input.Work = append(input.Work, brief)
	}
	return workspacedigest.SummaryPrompt(input)
}

// readInstructionFiles reads the start of the workspace's AGENTS.md /
// README from its device, at most DigestSourceBytes together.
func (s *Server) readInstructionFiles(ctx context.Context, workspace store.WorkspaceProjection) []workspacedigest.InstructionExcerpt {
	files, err := s.store.ListWorkspaceFiles(ctx, workspace.ID)
	if err != nil || !s.hub.HasConnection(workspace.DeviceID) {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, digestFileReadTimeout)
	defer cancel()
	excerpts := []workspacedigest.InstructionExcerpt{}
	budget := personalagent.DigestSourceBytes
	for _, path := range workspacedigest.InstructionFiles(files) {
		if budget <= 0 || len(excerpts) == 2 {
			break
		}
		read, err := s.hub.ReadWorkspaceFile(ctx, workspace, path)
		if err != nil || strings.TrimSpace(read.Content) == "" {
			continue
		}
		content := read.Content
		if len(content) > budget {
			content = content[:budget]
		}
		budget -= len(content)
		excerpts = append(excerpts, workspacedigest.InstructionExcerpt{Path: path, Content: content})
	}
	return excerpts
}

// finishDigestSummary takes a summary session's end: a valid answer is the
// project's summary now, anything else keeps the previous one.
func (s *Server) finishDigestSummary(ctx context.Context, session store.AgentSession) {
	record, refused, err := s.workspaceDigests().Complete(ctx, session.ID, session.Status == "completed", session.Response)
	switch {
	case errors.Is(err, workspacedigest.ErrNotSummarySession):
	case err != nil:
		log.Printf("finish summary session %s: %v", session.ID, err)
	case refused != nil:
		log.Printf("summary of %s kept its previous version: %v", record.Digest.WorkspaceID, refused)
	}
	if err == nil {
		// A first summary waiting for this one to end starts now.
		go s.runDigestSummaries(context.Background(), 0)
	}
}

// startOfDay is the start of now's day in the person's time zone (UTC when
// it is unknown).
func startOfDay(now time.Time, timezone string) time.Time {
	location, err := time.LoadLocation(timezone)
	if err != nil || timezone == "" {
		location = time.UTC
	}
	local := now.In(location)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, location)
}
