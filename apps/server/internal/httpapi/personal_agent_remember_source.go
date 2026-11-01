package httpapi

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) primaryKnowledgeVault(ctx context.Context, user string) (store.KnowledgeVault, error) {
	return s.store.GetKnowledgeVault(ctx, user, flow.Key("vault", user, "memory"))
}

// Returns handled=false only for existing legacy facts, which keep their
// original owner until the person explicitly migrates them.
func (s *Server) planRememberSource(ctx context.Context, scope paScope, spec paMemorySpec, item store.PersonalAgentMemoryItem, write paWrite) (paWrite, bool, error) {
	var v store.KnowledgeVault
	var err error
	if spec.Item.VaultID != "" {
		v, err = s.store.GetKnowledgeVault(ctx, scope.agent.UserID, spec.Item.VaultID)
	} else {
		v, err = s.primaryKnowledgeVault(ctx, scope.agent.UserID)
	}
	if errors.Is(err, store.ErrNotFound) && spec.Item.VaultID == "" {
		return write, false, nil
	}
	if err != nil {
		return write, true, err
	}
	if spec.Op != "add" && spec.Item.VaultID == "" && !strings.HasPrefix(spec.Item.ID, "knowledge_") {
		return write, false, nil
	}
	if _, err = s.knowledgeWorkspace(ctx, scope.agent.UserID, v); err != nil {
		return write, true, err
	}
	if spec.Op != "forget" && (item.Status != store.PersonalAgentMemoryActive || item.Origin != store.PersonalAgentMemoryStated) {
		write.apply = func(context.Context) (any, error) {
			return map[string]string{"status": "needs_confirmation", "note": "No source was written. This is an inference, not a confirmed fact. Ask the person to confirm it; their reply can then be saved with its exact quote."}, nil
		}
		return write, true, nil
	}
	if spec.Item.ExpiresAt != "" {
		if _, err = time.Parse(time.RFC3339, spec.Item.ExpiresAt); err != nil {
			return write, true, invalid("expiresAt requires an RFC3339 timestamp")
		}
	}
	origin := scope.turn
	if spec.Op != "forget" {
		origin, err = s.personFactSource(ctx, scope, spec.Item.Quote)
		if err != nil {
			return write, true, err
		}
	}
	sourceInput := origin.ID
	if entry, e := s.store.PersonalAgentInboxByInput(ctx, scope.agent.UserID, origin.ID); e == nil {
		sourceInput = entry.RootID
	}
	key := strings.TrimSpace(spec.Item.IntentKey)
	if key == "" || len(key) > 100 {
		return write, true, invalid("item.intentKey is required: a stable name for this fact within the person's input")
	}
	id := spec.Item.ID
	revision := int64(0)
	hash := ""
	if spec.Op == "add" {
		if id != "" {
			return write, true, invalid("add does not accept item.id")
		}
		id = flow.Key("knowledge", v.ID, sourceInput, key)
	} else {
		entry, err := s.store.GetKnowledgeEntry(ctx, scope.agent.UserID, v.ID, id)
		if err != nil {
			return write, true, err
		}
		if spec.Item.ExpectedRevision == nil || entry.Revision != *spec.Item.ExpectedRevision || entry.Hash != spec.Item.ExpectedHash {
			return write, true, invalid("read the source revision and hash before changing it")
		}
		revision, hash = entry.Revision, entry.Hash
	}
	title := strings.TrimSpace(spec.Item.Title)
	if title == "" && spec.Op != "forget" {
		return write, true, invalid("item.title is required for a knowledge source")
	}
	if len(title) > 200 {
		return write, true, invalid("knowledge title is too long")
	}
	action := "write"
	if spec.Op == "forget" {
		action = "forget"
	}
	job := store.KnowledgeMutation{ID: flow.Key("kwrite", scope.agent.UserID, v.ID, sourceInput, key, spec.Op), UserID: scope.agent.UserID, VaultID: v.ID, EntryID: id, Epoch: v.Epoch, Action: action, ExpectedRevision: revision, ExpectedHash: hash, Title: title, Body: item.Content, SourceRef: "session:" + scope.sessionID + "/event/evt_" + origin.ID, SourceVersion: origin.At, ExpiresAt: spec.Item.ExpiresAt}
	intent := job
	intent.Epoch = 0 // Location changes do not change the user's fact intent.
	fingerprint, err := flow.Fingerprint(struct {
		Body     string
		Mutation store.KnowledgeMutation
	}{job.Body, intent})
	if err != nil {
		return write, true, err
	}
	job.RequestHash = fingerprint
	write.apply = func(ctx context.Context) (any, error) {
		saved, err := s.store.CaptureKnowledgeMutation(ctx, job)
		if err != nil {
			return nil, err
		}
		return map[string]any{"status": "captured", "operation": saved, "note": "The owner file write is durable but may be waiting for its device. This does not publish the fact to another account or workspace."}, nil
	}
	return write, true, nil
}

// Resolve the actual user event, not the later notice that happened to recall
// it. Stable origin identity also prevents repeated notices duplicating a fact.
func (s *Server) personFactSource(ctx context.Context, scope paScope, quote string) (store.SessionInput, error) {
	matches := func(input store.SessionInput) bool {
		words, ok := personalagent.PersonWords(input)
		return ok && personalagent.QuoteGrounded(quote, []string{withoutTurnContext(words)})
	}
	if scope.turn.ID != "" && matches(scope.turn) {
		return scope.turn, nil
	}
	session, err := s.store.GetAgentSession(ctx, scope.sessionID)
	if err != nil {
		return store.SessionInput{}, err
	}
	for i := len(session.Events) - 1; i >= 0; i-- {
		event := session.Events[i]
		var input store.SessionInput
		switch {
		case event.Label == store.SessionInputEventLabel && event.Message != nil && event.Message.Kind == "user":
			input = store.SessionInput{ID: event.Message.ID, Prompt: event.Message.Text, At: event.At}
		case event.Label == steeredIntoTurnLabel:
			input = store.SessionInput{ID: strings.TrimPrefix(event.ID, "evt_"), Prompt: event.Detail, At: event.At}
		default:
			continue
		}
		if event.Metadata != nil {
			input.SentBySessionID = event.Metadata.SentBySessionID
			input.TimerFire = event.Metadata.TimerFire
		}
		if input.ID != "" && matches(input) {
			return input, nil
		}
	}
	return store.SessionInput{}, invalid("the stated fact has no attributable user event")
}
