package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// sessionUsageCapability is declared by workers that read a session's usage
// back from the agent's own log.
const sessionUsageCapability = "session_usage"

type wsReadSessionUsage struct {
	Provider         string   `json:"provider"`
	NativeSessionIDs []string `json:"nativeSessionIds"`
}

// nativeTurnUsage is one turn of the agent's own log: from a prompt to the
// next one.
type nativeTurnUsage struct {
	store.AgentTurnUsage
	StartedAt string `json:"startedAt"`
	EndedAt   string `json:"endedAt"`
}

// nativeRequestUsage is one Claude model request and the tool calls it made.
type nativeRequestUsage struct {
	Usage      store.ModelRequestUsage `json:"usage"`
	ToolUseIDs []string                `json:"toolUseIds"`
}

type wsSessionUsageRead struct {
	Turns    []nativeTurnUsage    `json:"turns"`
	Requests []nativeRequestUsage `json:"requests"`
	Error    string               `json:"error,omitempty"`
}

// sessionUsageStore is the store capability behind usage backfill.
type sessionUsageStore interface {
	AgentSessionNativeSessions(ctx context.Context, sessionID string) ([]store.NativeSessionRef, error)
	SessionUsageBackfilled(ctx context.Context, sessionID string) (bool, error)
	BackfillAgentSessionUsage(ctx context.Context, sessionID string, turns map[string]store.AgentTurnUsage, requests map[string]store.ModelRequestUsage) error
}

func (c *daemonConnection) readSessionUsage(ctx context.Context, provider string, nativeSessionIDs []string) (wsSessionUsageRead, error) {
	payload, err := json.Marshal(wsReadSessionUsage{Provider: provider, NativeSessionIDs: nativeSessionIDs})
	if err != nil {
		return wsSessionUsageRead{}, err
	}
	value, err := daemonRequest[wsSessionUsageRead](ctx, c, wsReadSessionUsageType, payload)
	if err == nil && value.Error != "" {
		err = errors.New(value.Error)
	}
	return value, err
}

// turnEndLabels mark the event that ends a Foundry turn and carries its
// usage.
var turnEndLabels = map[string]bool{"Claude Agent SDK finished": true, "Codex SDK finished": true}

// missingSessionUsage reports whether a finished session has turns without
// usage that its agent's log could supply.
func missingSessionUsage(session store.AgentSession) bool {
	if session.Provider != "claude" && session.Provider != "codex" {
		return false
	}
	if session.Status == "queued" || session.Status == "running" {
		return false
	}
	// A session that never ran natively has no log; one that did reads the
	// logs of every native session it owns.
	if session.NativeSessionID == "" {
		return false
	}
	for _, event := range session.Events {
		if turnEndLabels[event.Label] && (event.Metadata == nil || event.Metadata.TurnUsage == nil) {
			return true
		}
	}
	return false
}

// usageTolerance absorbs the gap between the agent writing its log and the
// worker reporting the turn.
const usageTolerance = 5 * time.Second

func parseEventTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

// matchSessionUsage places the turns of the agent's log on the Foundry turns
// they belong to. A Foundry turn runs from the person's message (or the end
// of the previous turn) to the event that ended it; the log's turns inside
// that window are its usage, steered inputs included. Tool steps get the
// usage of the model request that made them.
func matchSessionUsage(events []store.AgentSessionEvent, usage wsSessionUsageRead) (map[string]store.AgentTurnUsage, map[string]store.ModelRequestUsage) {
	turns := map[string]store.AgentTurnUsage{}
	used := make([]bool, len(usage.Turns))
	// Sessions recorded before messages were events start each turn where
	// the previous one ended (the first where the session began).
	var windowStart, previousEnd time.Time
	if len(events) > 0 {
		previousEnd = parseEventTime(events[0].At)
	}
	for _, event := range events {
		at := parseEventTime(event.At)
		if event.Message != nil && event.Message.Kind == "user" && windowStart.IsZero() {
			windowStart = at
		}
		if !turnEndLabels[event.Label] {
			continue
		}
		start := windowStart
		if start.IsZero() {
			start = previousEnd
		}
		windowStart, previousEnd = time.Time{}, at
		if event.Metadata != nil && event.Metadata.TurnUsage != nil {
			continue
		}
		var total store.AgentTurnUsage
		matched := 0
		for i, turn := range usage.Turns {
			began, ended := parseEventTime(turn.StartedAt), parseEventTime(turn.EndedAt)
			if used[i] || began.IsZero() || ended.After(at.Add(usageTolerance)) {
				continue
			}
			if !start.IsZero() && began.Before(start.Add(-usageTolerance)) {
				continue
			}
			used[i] = true
			matched++
			total = addTurnUsage(total, turn.AgentTurnUsage)
		}
		if matched == 0 {
			continue
		}
		if !start.IsZero() && at.After(start) {
			total.DurationMs = at.Sub(start).Milliseconds()
		}
		turns[event.ID] = total
	}
	requests := map[string]store.ModelRequestUsage{}
	byToolUse := map[string]store.ModelRequestUsage{}
	for _, request := range usage.Requests {
		for _, id := range request.ToolUseIDs {
			byToolUse[id] = request.Usage
		}
	}
	for _, event := range events {
		if event.Message == nil || event.Message.CallID == "" || countsRequestUsage(event.Message.RequestUsage) {
			continue
		}
		if request, ok := byToolUse[event.Message.CallID]; ok {
			requests[event.ID] = request
		}
	}
	return turns, requests
}

// countsRequestUsage reports a request usage with any tokens; relays
// sometimes report only zeros, which count as missing.
func countsRequestUsage(usage *store.ModelRequestUsage) bool {
	return usage != nil && (usage.InputTokens > 0 || usage.OutputTokens > 0)
}

func addTurnUsage(total, next store.AgentTurnUsage) store.AgentTurnUsage {
	optional := func(a, b *int64) *int64 {
		if a == nil && b == nil {
			return nil
		}
		sum := int64(0)
		if a != nil {
			sum += *a
		}
		if b != nil {
			sum += *b
		}
		return &sum
	}
	return store.AgentTurnUsage{
		DurationMs:       total.DurationMs + next.DurationMs,
		InputTokens:      total.InputTokens + next.InputTokens,
		CacheReadTokens:  total.CacheReadTokens + next.CacheReadTokens,
		CacheWriteTokens: total.CacheWriteTokens + next.CacheWriteTokens,
		OutputTokens:     total.OutputTokens + next.OutputTokens,
		ReasoningTokens:  optional(total.ReasoningTokens, next.ReasoningTokens),
		ModelRequests:    optional(total.ModelRequests, next.ModelRequests),
	}
}

// sessionUsageBackfills runs each session's backfill once at a time.
var sessionUsageBackfills sync.Map

// sessionUsageWait is how long opening a chat waits for its backfill; a
// slower one finishes in the background and shows on the next load.
const sessionUsageWait = 4 * time.Second

// backfillSessionUsage reads, once per session, the usage of turns Foundry
// ran before it recorded usage, from the agent's log on the session's
// device. It runs when a chat is opened, never on its own. It returns the
// sessions with any usage it stored.
func (s *Server) backfillSessionUsage(ctx context.Context, sessions []store.AgentSession) []store.AgentSession {
	usageStore, ok := s.store.(sessionUsageStore)
	if !ok {
		return sessions
	}
	for i, session := range sessions {
		if !missingSessionUsage(session) {
			continue
		}
		connection := s.hub.connectionFor(session.DeviceID)
		if connection == nil || !connection.hasCapability(sessionUsageCapability) {
			continue
		}
		if done, err := usageStore.SessionUsageBackfilled(ctx, session.ID); err != nil || done {
			continue
		}
		finished := make(chan struct{})
		if _, running := sessionUsageBackfills.LoadOrStore(session.ID, finished); running {
			continue
		}
		go func(session store.AgentSession) {
			defer sessionUsageBackfills.Delete(session.ID)
			defer close(finished)
			s.runSessionUsageBackfill(usageStore, connection, session)
		}(session)
		select {
		case <-finished:
			if reloaded, err := s.store.GetAgentSession(ctx, session.ID); err == nil {
				sessions[i] = reloaded
			}
		case <-time.After(sessionUsageWait):
		case <-ctx.Done():
			return sessions
		}
	}
	return sessions
}

// readOwnedSessionUsage reads the logs of every native session a session
// owns, one read per provider, as one usage in time order.
func readOwnedSessionUsage(owned []store.NativeSessionRef, read func(provider string, ids []string) (wsSessionUsageRead, error)) (wsSessionUsageRead, error) {
	byProvider := map[string][]string{}
	providers := []string{}
	for _, ref := range owned {
		if byProvider[ref.Provider] == nil {
			providers = append(providers, ref.Provider)
		}
		byProvider[ref.Provider] = append(byProvider[ref.Provider], ref.NativeSessionID)
	}
	var usage wsSessionUsageRead
	for _, provider := range providers {
		value, err := read(provider, byProvider[provider])
		if err != nil {
			return wsSessionUsageRead{}, err
		}
		usage.Turns = append(usage.Turns, value.Turns...)
		usage.Requests = append(usage.Requests, value.Requests...)
	}
	sort.SliceStable(usage.Turns, func(i, j int) bool {
		return parseEventTime(usage.Turns[i].StartedAt).Before(parseEventTime(usage.Turns[j].StartedAt))
	})
	return usage, nil
}

func (s *Server) runSessionUsageBackfill(usageStore sessionUsageStore, connection *daemonConnection, session store.AgentSession) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// Every native session the session owns, on whichever runtime it ran.
	owned, err := usageStore.AgentSessionNativeSessions(ctx, session.ID)
	if err != nil {
		log.Printf("usage backfill of %s: %v", session.ID, err)
		return
	}
	if len(owned) == 0 {
		return
	}
	usage, err := readOwnedSessionUsage(owned, func(provider string, ids []string) (wsSessionUsageRead, error) {
		return connection.readSessionUsage(ctx, provider, ids)
	})
	if err != nil {
		log.Printf("usage backfill of %s: %v", session.ID, err)
		return
	}
	turns, requests := matchSessionUsage(session.Events, usage)
	if err := usageStore.BackfillAgentSessionUsage(ctx, session.ID, turns, requests); err != nil {
		log.Printf("usage backfill of %s: %v", session.ID, strings.TrimSpace(err.Error()))
		return
	}
	if len(turns) > 0 || len(requests) > 0 {
		s.invalidateProjections()
	}
}
