package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/modelpool"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// memberHealth is the live rate-limit breaker of every account (rate-limit
// domain) that worker group members run on. It is in memory: a restart starts
// closed, and the breaker learns again from the next signals.
type memberHealth struct {
	mu      sync.Mutex
	tracker *modelpool.HealthTracker
}

func newMemberHealth() *memberHealth {
	return &memberHealth{tracker: modelpool.NewHealthTracker()}
}

// memberDomain names the rate-limit domain of a runtime's account: members on
// the same account share it, whatever their model.
func memberDomain(profileID, runtime string) string {
	return runtime + "\x00" + profileID
}

func (h *memberHealth) observeRateLimit(domain, sessionID string, at time.Time, active int, hint time.Duration) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.tracker.Observe(domain, sessionID, at, active, hint)
}

func (h *memberHealth) observeSuccess(domain string, at time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.tracker.Succeeded(domain, at)
}

func (h *memberHealth) snapshot(domain string, at time.Time, active int) modelpool.DomainStatus {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.tracker.Snapshot(domain, at, 0, active)
}

func (h *memberHealth) observeUnusable(domain string, at time.Time, cooldown time.Duration, reason string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.tracker.ObserveUnusable(domain, at, cooldown, reason)
}

func (h *memberHealth) recordFailover(domain string, at time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.tracker.RecordFailover(domain, at)
}

func (h *memberHealth) reserve(domain string, at time.Time) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.tracker.Reserve(domain, at)
}

// activeSessionsByDomain counts the running or blocked sessions per
// rate-limit domain, not counting exclude.
func activeSessionsByDomain(ctx context.Context, sessions store.ActiveAgentSessionStore, exclude string) (map[string]int, error) {
	active, err := sessions.ActiveAgentSessions(ctx)
	if err != nil {
		return nil, err
	}
	counts := map[string]int{}
	for _, session := range active {
		if session.ID == exclude || session.ProfileID == "" {
			continue
		}
		counts[memberDomain(session.ProfileID, session.Provider)]++
	}
	return counts, nil
}

// workerGroupView is the group as the API shows it: its stored members and the
// live state of each rate-limit domain they run on.
func (s *Server) workerGroupView(ctx context.Context, group store.StoredWorkerGroup) (store.WorkerGroup, error) {
	public := publicWorkerGroup(group)
	active, err := activeSessionsByDomain(ctx, s.store, "")
	if err != nil {
		return store.WorkerGroup{}, err
	}
	now := time.Now().UTC()
	seen := map[string]bool{}
	for _, member := range group.Members {
		domain := memberDomain(member.ProviderID, string(member.Runtime))
		if seen[domain] {
			continue
		}
		seen[domain] = true
		status := s.hub.health.snapshot(domain, now, active[domain])
		view := store.WorkerGroupDomain{
			ProfileID: member.ProviderID, Runtime: member.Runtime,
			State: store.WorkerGroupDomainState(status.State), Level: status.Level, Limit: status.Limit,
			Active: active[domain], SignalsInWindow: status.SignalsInWindow, FailoversLastHour: status.FailoversLastHour,
		}
		view.Reason = status.Reason
		if !status.CooldownUntil.IsZero() {
			view.CooldownUntil = status.CooldownUntil.UTC().Format(time.RFC3339Nano)
		}
		public.Domains = append(public.Domains, view)
	}
	return public, nil
}

// admissionCandidates describes members for modelpool: each one's tier, its
// domain's breaker state and the sessions on it. Index is the member's
// position in members.
func (s *Server) admissionCandidates(ctx context.Context, members []store.WorkerGroupMember, exclude string) ([]modelpool.Candidate, error) {
	active, err := activeSessionsByDomain(ctx, s.store, exclude)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	candidates := make([]modelpool.Candidate, len(members))
	for index, member := range members {
		domain := memberDomain(member.ProviderID, string(member.Runtime))
		status := s.hub.health.snapshot(domain, now, active[domain])
		candidates[index] = modelpool.Candidate{
			Index: index, Tier: member.Tier, Health: status.State, Active: active[domain], Limit: status.Limit,
		}
	}
	return candidates, nil
}

// admitMember picks the member a session starts or continues on from the
// group members the device can run: the lowest tier with headroom, the least
// loaded primary when none has any. A probing member's one probe is reserved.
func (s *Server) admitMember(ctx context.Context, members []store.WorkerGroupMember, exclude string) (store.WorkerGroupMember, bool, error) {
	candidates, err := s.admissionCandidates(ctx, members, exclude)
	if err != nil {
		return store.WorkerGroupMember{}, false, err
	}
	indexes, queued := modelpool.Admit(candidates)
	if len(indexes) == 0 {
		return store.WorkerGroupMember{}, false, errors.New("worker group has no member to admit")
	}
	member := members[indexes[0]]
	if candidates[indexes[0]].Health == modelpool.Probing {
		s.hub.health.reserve(memberDomain(member.ProviderID, string(member.Runtime)), time.Now().UTC())
	}
	return member, queued, nil
}

// observeMemberSignal feeds one session event to the breaker: a rate-limit
// wait counts against the session's account, and a model request that ran
// there shows the account serving again.
func (h *DaemonHub) observeMemberSignal(ctx context.Context, event store.AgentSessionEvent) {
	isLimit := event.Label == store.ProcessLabelRateLimited
	isRequest := event.Metadata != nil && event.Metadata.RequestUsage != nil
	if !isLimit && !isRequest {
		return
	}
	session, err := h.store.GetAgentSessionSummary(ctx, event.SessionID)
	if err != nil || session.ProfileID == "" {
		return
	}
	if !isLimit {
		h.health.observeSuccess(memberDomain(session.ProfileID, session.Provider), time.Now().UTC())
		return
	}
	h.observeRateLimitedSession(ctx, session, event.Detail)
}

// observeRateLimitedSession counts one rate-limit signal of a session against
// its account. text is the failure or wait text the provider sent: a reset
// time in it floors the cooldown. The session itself is among the active
// sessions counted.
func (h *DaemonHub) observeRateLimitedSession(ctx context.Context, session store.AgentSession, text string) {
	if session.ProfileID == "" {
		return
	}
	active, err := activeSessionsByDomain(ctx, h.store, "")
	if err != nil {
		log.Printf("member health: count active sessions for %s: %v", session.ID, err)
		return
	}
	now := time.Now().UTC()
	domain := memberDomain(session.ProfileID, session.Provider)
	h.health.observeRateLimit(domain, session.ID, now, active[domain], retryAfterHint(text, now))
}

// observeAccountUnusable opens the session's account breaker for a failure
// the account cannot recover from by itself (billing arrears, exhausted quota,
// a disabled account). reason is modelpool.AccountUnusableReason's name for it.
// The observation is stored, so a restart rebuilds the breaker until its cooldown ends.
func (h *DaemonHub) observeAccountUnusable(ctx context.Context, session store.AgentSession, text, reason string) {
	if session.ProfileID == "" {
		return
	}
	now := time.Now().UTC()
	cooldown := modelpool.UnusableCooldownFor(retryAfterHint(text, now))
	h.health.observeUnusable(memberDomain(session.ProfileID, session.Provider), now, cooldown, reason)
	observation := store.AccountUnusableObservation{
		Runtime: session.Provider, ProfileID: session.ProfileID, SessionID: session.ID,
		Reason: reason, ObservedAt: now, CooldownUntil: now.Add(cooldown),
	}
	if err := h.store.RecordAccountUnusable(ctx, observation); err != nil {
		log.Printf("member health: record account unusable of %s: %v", session.ID, err)
	}
}

// retryAfterHint is the wait a rate-limit text names: the reset time the
// failure parser reads from it, relative to now. Zero when none is named.
func retryAfterHint(text string, now time.Time) time.Duration {
	reset := parseFailureReset(text, now)
	if reset.IsZero() || !reset.After(now) {
		return 0
	}
	return reset.Sub(now)
}

// fallbackMember is the member a rate-limited session moves to when its
// account's breaker is open: a same-runtime member of a higher tier with
// headroom that the session's device can run. current is the member it moves
// off. ok is false when the session is not in a group, its account is not
// limited, or no member fits.
func (s *Server) fallbackMember(ctx context.Context, session store.AgentSession) (fallback, current store.WorkerGroupMember, ok bool, err error) {
	if session.WorkerGroupID == "" {
		return fallback, current, false, nil
	}
	group, err := s.store.GetWorkerGroup(ctx, session.WorkerGroupID)
	if err != nil {
		return fallback, current, false, err
	}
	workspace, err := s.store.GetWorkspace(ctx, session.WorkspaceID)
	if err != nil {
		return fallback, current, false, err
	}
	accounts, err := s.workspaceAccounts(ctx, workspace, group.OwnerUserID)
	if err != nil {
		return fallback, current, false, err
	}
	found := false
	var runnable []store.WorkerGroupMember
	for _, member := range group.Members {
		if string(member.Runtime) != session.Provider {
			continue
		}
		if ok, _ := memberAvailability(accounts, member); !ok {
			continue
		}
		if member.ProviderID == session.ProfileID && member.Model == session.Model {
			current, found = member, true
		}
		runnable = append(runnable, member)
	}
	if !found {
		return fallback, current, false, nil
	}
	domain := memberDomain(current.ProviderID, string(current.Runtime))
	if s.hub.health.snapshot(domain, time.Now().UTC(), 0).State != modelpool.Limited {
		return fallback, current, false, nil
	}
	candidates, err := s.admissionCandidates(ctx, runnable, session.ID)
	if err != nil {
		return fallback, current, false, err
	}
	indexes := modelpool.Fallback(candidates, max(current.Tier, 1))
	if len(indexes) == 0 {
		return fallback, current, false, nil
	}
	return runnable[indexes[0]], current, true, nil
}

// memberNote says, in the session's language, why a session runs on a member
// other than the primary: the primary's account is rate limited and recovers
// at a time, it was just limited, or every member is limited and the session
// waits on the primary.
func memberNote(zh bool, chosenModel, primaryModel string, status modelpool.DomainStatus, now time.Time, queued bool) string {
	minutes := 0
	if status.State == modelpool.Limited && status.CooldownUntil.After(now) {
		minutes = int(math.Ceil(status.CooldownUntil.Sub(now).Minutes()))
	}
	switch {
	case queued && zh:
		return fmt.Sprintf("排队到主力 %s：所有成员都在限流或已满，有空位时开始", primaryModel)
	case queued:
		return fmt.Sprintf("Queued on %s: every member is rate limited or full; it starts when a slot frees", primaryModel)
	case status.Reason != "" && zh:
		return fmt.Sprintf("备用 %s：%s 账号不可用（%s）", chosenModel, primaryModel, status.Reason)
	case status.Reason != "":
		return fmt.Sprintf("Fallback %s: the %s account is unusable (%s)", chosenModel, primaryModel, status.Reason)
	case minutes > 0 && zh:
		return fmt.Sprintf("备用 %s：%s 账号限流中，约 %d 分钟后恢复", chosenModel, primaryModel, minutes)
	case minutes > 0:
		return fmt.Sprintf("Fallback %s: the %s account is rate limited, recovering in about %d min", chosenModel, primaryModel, minutes)
	case zh:
		return fmt.Sprintf("备用 %s：%s 账号刚限流，先用备用", chosenModel, primaryModel)
	default:
		return fmt.Sprintf("Fallback %s: the %s account was just rate limited; using the fallback meanwhile", chosenModel, primaryModel)
	}
}

// sessionPrefersChinese reports whether the person a session belongs to reads
// Chinese; their notes are written in Chinese.
func (s *Server) sessionPrefersChinese(ctx context.Context, userID string) bool {
	if userID == "" {
		return false
	}
	user, err := s.store.GetUser(ctx, userID)
	if err != nil {
		return false
	}
	return strings.HasPrefix(strings.ToLower(user.Locale), "zh")
}

// memberRoutingNote is the note for a session starting on chosen: empty when
// it takes the group's primary for its runtime and the primary is not limited.
func (s *Server) memberRoutingNote(ctx context.Context, group store.StoredWorkerGroup, chosen store.WorkerGroupMember) (string, error) {
	primary, found := store.WorkerGroupMember{}, false
	for _, member := range group.Members {
		if member.Runtime == chosen.Runtime && max(member.Tier, 1) == 1 {
			primary, found = member, true
			break
		}
	}
	if !found {
		return "", nil
	}
	now := time.Now().UTC()
	status := s.hub.health.snapshot(memberDomain(primary.ProviderID, string(primary.Runtime)), now, 0)
	zh := s.sessionPrefersChinese(ctx, group.OwnerUserID)
	switch {
	case chosen.Tier > 1:
		return memberNote(zh, chosen.Model, primary.Model, status, now, false), nil
	case chosen.ProviderID == primary.ProviderID && chosen.Model == primary.Model && status.State == modelpool.Limited:
		return memberNote(zh, chosen.Model, primary.Model, status, now, true), nil
	}
	return "", nil
}

// MemberSwitchAnswer says what a manual member switch did to a running
// session: retry_now (its pending rate-limit retry runs on the member) or
// next_turn (the member takes the next turn after this one settles).
type MemberSwitchAnswer struct {
	State string `json:"state"`
	Note  string `json:"note"`
}

// memberSwitchFor describes the switch a manual message left pending on a
// session. ok is false when the session has none.
func (s *Server) memberSwitchFor(ctx context.Context, session store.AgentSession) (MemberSwitchAnswer, bool) {
	retry, found, err := s.store.GetSessionRetry(ctx, session.ID, session.Input.ID)
	if err == nil && found && retry.Status == store.SessionRetryPending && retry.NextProfileID != "" {
		return MemberSwitchAnswer{State: "retry_now",
			Note: fmt.Sprintf("The rate-limited retry runs now on %s; the message is with the session.", retry.NextModel)}, true
	}
	pending, ok, err := s.store.GetPendingSessionMember(ctx, session.ID)
	if err != nil || !ok {
		return MemberSwitchAnswer{}, false
	}
	return MemberSwitchAnswer{State: "next_turn",
		Note: fmt.Sprintf("The switch to %s applies to the next turn after this turn settles; the message is in the running turn.", pending.Model)}, true
}

// withMemberSwitch adds the member switch to a session answer.
func withMemberSwitch(answer any, memberSwitch MemberSwitchAnswer) any {
	encoded, err := json.Marshal(answer)
	if err != nil {
		return answer
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return answer
	}
	fields["memberSwitch"] = memberSwitch
	return fields
}

// noteMemberRouting records a new session's routing note as a session event.
func (s *Server) noteMemberRouting(ctx context.Context, session store.AgentSession, note string) {
	if note == "" {
		return
	}
	if err := s.recordMemberEvent(ctx, session, note); err != nil {
		log.Printf("session %s: record member note: %v", session.ID, err)
	}
}

// failoverNote is the note for a session moved off its limited member.
func (s *Server) failoverNote(ctx context.Context, session store.AgentSession, fallback, current store.WorkerGroupMember, now time.Time) (string, error) {
	status := s.hub.health.snapshot(memberDomain(current.ProviderID, string(current.Runtime)), now, 0)
	return memberNote(s.sessionPrefersChinese(ctx, session.CreatedByUserID), fallback.Model, current.Model, status, now, false), nil
}

// settledTurnMember is the member a settled session's next turn runs on. A
// pending manual switch wins; otherwise the session moves when admission
// prefers another member of its runtime (back to a healthy primary, or off a
// limited account). It returns false when the session keeps its member.
func (s *Server) settledTurnMember(ctx context.Context, session store.AgentSession) (store.WorkerGroupMember, bool, error) {
	group, err := s.store.GetWorkerGroup(ctx, session.WorkerGroupID)
	if err != nil {
		return store.WorkerGroupMember{}, false, err
	}
	workspace, err := s.store.GetWorkspace(ctx, session.WorkspaceID)
	if err != nil {
		return store.WorkerGroupMember{}, false, err
	}
	accounts, err := s.workspaceAccounts(ctx, workspace, group.OwnerUserID)
	if err != nil {
		return store.WorkerGroupMember{}, false, err
	}
	var runnable []store.WorkerGroupMember
	current, currentFound := -1, false
	for _, member := range group.Members {
		if string(member.Runtime) != session.Provider {
			continue
		}
		if ok, _ := memberAvailability(accounts, member); !ok {
			continue
		}
		if member.ProviderID == session.ProfileID && member.Model == session.Model {
			current, currentFound = len(runnable), true
		}
		runnable = append(runnable, member)
	}
	if len(runnable) == 0 {
		return store.WorkerGroupMember{}, false, nil
	}
	candidates, err := s.admissionCandidates(ctx, runnable, "")
	if err != nil {
		return store.WorkerGroupMember{}, false, err
	}
	if currentFound && candidates[current].Health == modelpool.Healthy &&
		candidates[current].Active < candidates[current].Limit && candidates[current].Tier <= 1 {
		return store.WorkerGroupMember{}, false, nil
	}
	member, _, err := s.admitMember(ctx, runnable, "")
	if err != nil {
		return store.WorkerGroupMember{}, false, err
	}
	if currentFound && member.ProviderID == session.ProfileID && member.Model == session.Model {
		return store.WorkerGroupMember{}, false, nil
	}
	// Admission queues on a primary when nothing has headroom; a settled
	// session never moves onto an account whose breaker is open.
	if s.hub.health.snapshot(memberDomain(member.ProviderID, string(member.Runtime)), time.Now().UTC(), 0).State == modelpool.Limited {
		return store.WorkerGroupMember{}, false, nil
	}
	return member, true, nil
}

// chooseSettledMember sets the member a settled group session's next turn
// runs on: a manual switch requested while a turn ran, else admission.
func (s *Server) chooseSettledMember(ctx context.Context, session store.AgentSession, input *store.SendAgentSessionInput) error {
	pending, ok, err := s.store.TakePendingSessionMember(ctx, session.ID)
	if err != nil {
		return err
	}
	if ok {
		input.ProfileID, input.Model = pending.ProfileID, pending.Model
		return nil
	}
	member, moved, err := s.settledTurnMember(ctx, session)
	if err != nil || !moved {
		return err
	}
	input.ProfileID, input.Model = member.ProviderID, member.Model
	return s.recordMemberEvent(ctx, session, fmt.Sprintf("Next turn runs on %s (%s): admission chose it.", member.Model, member.ProviderID))
}

// applyRunningMemberSwitch takes a manual switch to another member of the
// session's worker group, while the session runs or is blocked. A pending
// rate-limit retry moves to the member and runs now; otherwise the switch
// applies to the next turn after this one settles. applied reports that the
// switch was taken: its runtime and account fields are cleared from input.
// Any other switch is left for the caller to refuse.
func (s *Server) applyRunningMemberSwitch(ctx context.Context, session store.AgentSession, input *store.SendAgentSessionInput) (bool, error) {
	if session.WorkerGroupID == "" || input.AgentID != "" || input.ProfileID == "" && input.Model == "" {
		return false, nil
	}
	if input.Provider != "" && input.Provider != session.Provider {
		return false, nil
	}
	group, err := s.store.GetWorkerGroup(ctx, session.WorkerGroupID)
	if err != nil {
		return false, err
	}
	member, ok := groupMemberNamed(group, session.Provider, input.ProfileID, input.Model)
	if !ok {
		return false, nil
	}
	now := time.Now().UTC()
	detail := fmt.Sprintf("Switch to %s (%s) requested while a turn runs: it applies after this turn settles.", member.Model, member.ProviderID)
	retry, found, err := s.store.GetSessionRetry(ctx, session.ID, session.Input.ID)
	if err != nil {
		return false, err
	}
	if found && retry.Status == store.SessionRetryPending {
		moved, err := s.store.SetSessionRetryNextMember(ctx, session.ID, session.Input.ID, member.ProviderID, member.Model, now)
		if err != nil {
			return false, err
		}
		if moved {
			detail = fmt.Sprintf("Rate-limited retry moves to %s (%s) and runs now.", member.Model, member.ProviderID)
		}
		if moved {
			clearMemberFields(input)
			return true, s.recordMemberEvent(ctx, session, detail)
		}
	}
	if err := s.store.SetPendingSessionMember(ctx, session.ID, store.PendingSessionMember{
		ProfileID: member.ProviderID, Model: member.Model, RequestedAt: now,
	}); err != nil {
		return false, err
	}
	clearMemberFields(input)
	return true, s.recordMemberEvent(ctx, session, detail)
}

func clearMemberFields(input *store.SendAgentSessionInput) {
	input.AgentID, input.Provider, input.ProfileID, input.Model = "", "", "", ""
}

// groupMemberNamed finds the member of a group on runtime with the account
// profileID, and the model when one is named.
func groupMemberNamed(group store.StoredWorkerGroup, runtime, profileID, model string) (store.WorkerGroupMember, bool) {
	for _, member := range group.Members {
		if string(member.Runtime) != runtime || member.ProviderID != profileID {
			continue
		}
		if model == "" || member.Model == model {
			return member, true
		}
	}
	return store.WorkerGroupMember{}, false
}

func (s *Server) recordMemberEvent(ctx context.Context, session store.AgentSession, detail string) error {
	event := store.AgentSessionEvent{
		ID:        fmt.Sprintf("evt_%s_member_%d", session.ID, time.Now().UnixNano()),
		SessionID: session.ID, At: time.Now().UTC().Format(time.RFC3339Nano),
		Label: "Worker group member", Detail: detail, Level: "info",
	}
	if err := s.store.AppendAgentSessionEvent(ctx, event); err != nil {
		return err
	}
	s.hub.sessions.Recorded(ctx, session.WorkspaceID, event)
	return nil
}

// memberRestoreWindow is how far back a restart replays rate-limit waits, so a
// deploy does not forget a storm the breaker was in.
const memberRestoreWindow = 30 * time.Minute

// restoreMemberHealth replays the rate-limit waits of the running and blocked
// sessions from the last memberRestoreWindow into the breaker, in time order.
// The breaker starts closed at a restart; this rebuilds what the stored events
// say it saw.
func (s *Server) restoreMemberHealth(ctx context.Context, now time.Time) error {
	active, err := s.store.ActiveAgentSessions(ctx)
	if err != nil {
		return err
	}
	counts, err := activeSessionsByDomain(ctx, s.store, "")
	if err != nil {
		return err
	}
	since := now.Add(-memberRestoreWindow)
	type replayed struct {
		at      time.Time
		session store.AgentSession
		text    string
	}
	var signals []replayed
	for _, session := range active {
		if session.ProfileID == "" {
			continue
		}
		before := ""
		for range restorePages {
			page, older, err := s.store.AgentSessionEventWindow(ctx, session.ID, before, restorePageSize)
			if err != nil {
				return err
			}
			for _, event := range page {
				at, err := time.Parse(time.RFC3339Nano, event.At)
				if event.Label != store.ProcessLabelRateLimited || err != nil || at.Before(since) {
					continue
				}
				signals = append(signals, replayed{at: at, session: session, text: event.Detail})
			}
			if older == "" {
				break
			}
			before = older
		}
	}
	sort.SliceStable(signals, func(i, j int) bool { return signals[i].at.Before(signals[j].at) })
	for _, signal := range signals {
		domain := memberDomain(signal.session.ProfileID, signal.session.Provider)
		s.hub.health.observeRateLimit(domain, signal.session.ID, signal.at, counts[domain], retryAfterHint(signal.text, signal.at))
	}
	observations, err := s.store.AccountUnusableSince(ctx, now.Add(-accountUnusableRestoreWindow), now)
	if err != nil {
		return err
	}
	for _, observation := range observations {
		s.hub.health.observeUnusable(memberDomain(observation.ProfileID, observation.Runtime),
			observation.ObservedAt, observation.CooldownUntil.Sub(observation.ObservedAt), observation.Reason)
	}
	return nil
}

const (
	restorePageSize = 200
	restorePages    = 20
	// accountUnusableRestoreWindow is how far back a restart replays account-unusable
	// observations. An observation still in its cooldown is replayed whatever its age.
	accountUnusableRestoreWindow = 24 * time.Hour
)
