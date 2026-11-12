package assistant

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/knowledge"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// What the assistant remembers of the person (docs/personal-agent.md §2)
// and the rules it follows (§4): remember and update_rules, each fact
// grounded in the person's own words.

// ruleSpec is update_rules' arguments.
type ruleSpec struct {
	Change store.PersonalAgentRuleChange `json:"change"`
}

func (s *Service) planRuleChange(ctx context.Context, scope Scope, args map[string]json.RawMessage) (Write, error) {
	var spec ruleSpec
	if err := DecodeArgs(args, &spec); err != nil {
		return Write{ArgsSummary: "update_rules"}, err
	}
	write := Write{ArgsSummary: spec.Change.Action + " -> " + spec.Change.Decision, Spec: spec}
	plan, err := personalagent.PlanRuleChange(scope.Agent.Settings.Policy, spec.Change)
	if err != nil {
		return write, invalid("%v", err)
	}
	language := personalagent.LanguageOf(scope.Agent.Settings, s.AccountLocale(ctx, scope.Agent.UserID))
	write.Subject = personalagent.RuleSummary(language, spec.Change)
	if plan.Propose {
		write.ProposalKind = store.PersonalAgentProposalRelaxRules
	}
	write.Apply = func(ctx context.Context) (any, error) {
		return s.applyRuleChange(ctx, scope.Agent.ID, args)
	}
	return write, nil
}

func (s *Service) applyRuleChange(ctx context.Context, assistantID string, args map[string]json.RawMessage) (any, error) {
	var spec ruleSpec
	if err := DecodeArgs(args, &spec); err != nil {
		return nil, err
	}
	agent, err := s.store.GetAssistant(ctx, assistantID)
	if err != nil {
		return nil, err
	}
	settings := agent.Settings
	settings.Policy = personalagent.WithRule(settings.Policy, spec.Change)
	if _, err := s.store.SavePersonalAgentSettings(ctx, assistantID, settings); err != nil {
		return nil, err
	}
	return map[string]string{"status": "applied", "action": spec.Change.Action, "decision": spec.Change.Decision}, nil
}

// memorySpec is remember's arguments. Scope is the layer a new fact goes
// to (store.MemoryScopeAssistant by default, or the person's layer).
type memorySpec struct {
	Op    string         `json:"op"`
	Scope string         `json:"scope,omitempty"`
	Item  memoryItemArgs `json:"item"`
}

// memoryItemArgs is remember's item: quote is the person's words the
// fact rests on, which the server looks for in what they wrote (§2).
type memoryItemArgs struct {
	VaultID          string `json:"vaultId,omitempty"`
	IntentKey        string `json:"intentKey,omitempty"`
	Title            string `json:"title,omitempty"`
	ExpiresAt        string `json:"expiresAt,omitempty"`
	ExpectedRevision *int64 `json:"expectedRevision,omitempty"`
	ExpectedHash     string `json:"expectedHash,omitempty"`
	store.PersonalAgentMemoryInput
	Quote string `json:"quote,omitempty"`
}

// Why a fact the assistant gave was not written.
const (
	memoryNoteInferred   = "No source was written. This is an inference, not a confirmed fact. Ask the person to confirm it; their reply can then be saved with its exact quote."
	memoryNoteUngrounded = "No source was written: the quote is not in anything the person wrote in this conversation (a document, web page, file, helper's output or Foundry's own notice is not their words). If the person did say it, quote their exact words; if you concluded it, ask them to confirm it."
	memoryNoteExternal   = "No source was written: this did not come from the person's own words in this conversation. Ask the person to confirm it; their reply can then be saved with its exact quote."
)

// planRemember stores, corrects or forgets one fact about the person. A
// fact given as the person's is theirs only when its quote is found in
// what they wrote in this conversation; otherwise it waits for them. Its
// audit keeps the op and the item id, never the content or quote:
// forgetting erases it everywhere (§2).
func (s *Service) planRemember(ctx context.Context, scope Scope, args map[string]json.RawMessage) (Write, error) {
	var spec memorySpec
	if err := DecodeArgs(args, &spec); err != nil {
		return Write{ArgsSummary: "remember"}, err
	}
	write := Write{ArgsSummary: strings.TrimSpace(spec.Op + " " + spec.Item.ID),
		Spec: map[string]any{"op": spec.Op, "item": map[string]string{"id": spec.Item.ID}}}
	item := store.PersonalAgentMemoryItem{
		UserID: scope.Agent.UserID, AssistantID: scope.Agent.ID, SourceSessionID: scope.SessionID, SourceInputID: scope.Turn.ID,
	}
	note := memoryNoteInferred
	switch spec.Op {
	case store.PersonalAgentMemoryAdd, store.PersonalAgentMemoryUpdate:
		content, err := personalagent.MemoryContent(spec.Item.Content)
		if err != nil {
			return write, invalid("%v", err)
		}
		item.Content = content
		grounded := false
		if !spec.Item.Inferred {
			quote := strings.TrimSpace(spec.Item.Quote)
			if quote == "" {
				return write, invalid("item.quote is required: copy the person's own words this fact rests on from their messages in this conversation, or set item.inferred when you concluded it")
			}
			said, err := s.personSaid(ctx, scope.SessionID, scope.Turn)
			if err != nil {
				return write, err
			}
			grounded = personalagent.QuoteGrounded(quote, said)
			note = memoryNoteExternal
			if len(said) > 0 {
				note = memoryNoteUngrounded
			}
		}
		item.Origin = personalagent.MemoryOrigin(spec.Item.Inferred, grounded)
		item.Status = personalagent.MemoryStatus(item.Origin)
	case store.PersonalAgentMemoryForget:
	default:
		return write, invalid("op must be add, update or forget")
	}
	id := strings.TrimSpace(spec.Item.ID)
	if spec.Op == store.PersonalAgentMemoryAdd || spec.Item.VaultID != "" || strings.HasPrefix(id, "knowledge_") {
		return s.planRememberSource(ctx, scope, spec, item, write, note)
	}
	// A legacy fact (pa_memory) is read-only since the layers (DEV-191 P2):
	// it was copied to the person's layer. Forgetting still erases it and
	// its copy.
	existing, err := s.store.GetPersonalAgentMemory(ctx, scope.Agent.UserID, id)
	if err != nil || existing.Status == store.PersonalAgentMemoryForgotten || existing.Status == store.PersonalAgentMemorySuperseded {
		return write, refuse(store.PersonalAgentRefusalInvalid, http.StatusNotFound, "no current memory item %q", spec.Item.ID)
	}
	if spec.Op != store.PersonalAgentMemoryForget {
		return write, invalid("memory item %q is a read-only legacy fact; read_memory shows its copy in the person's layer: update that entry, or add the corrected fact", id)
	}
	write.Apply = func(ctx context.Context) (any, error) {
		if err := s.store.ForgetPersonalAgentMemory(ctx, scope.Agent.UserID, id); err != nil {
			return nil, err
		}
		return map[string]string{"status": "forgotten", "id": spec.Item.ID}, nil
	}
	return write, nil
}

// rememberVault is where remember writes: the named vault (a layer the
// assistant recalls or a domain source), for a new fact its layer
// spec.Scope (created the first time), and for a change the layer holding
// the entry.
func (s *Service) rememberVault(ctx context.Context, agent store.PersonalAgent, spec memorySpec) (store.KnowledgeVault, error) {
	if spec.Item.VaultID != "" {
		v, err := s.store.GetKnowledgeVault(ctx, agent.UserID, spec.Item.VaultID)
		if err == nil && !knowledge.Recalls(agent, v) {
			err = store.ErrNotFound
		}
		return v, err
	}
	if spec.Op == store.PersonalAgentMemoryAdd {
		return s.knowledge.EnsureMemoryLayer(ctx, agent, cmp.Or(spec.Scope, store.MemoryScopeAssistant))
	}
	scopes := []string{store.MemoryScopeAssistant, store.MemoryScopePerson}
	if spec.Scope != "" {
		scopes = []string{spec.Scope}
	}
	for _, layer := range scopes {
		v, err := s.knowledge.MemoryLayer(ctx, agent, layer)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return v, err
		}
		if _, err = s.store.GetKnowledgeEntry(ctx, agent.UserID, v.ID, strings.TrimSpace(spec.Item.ID)); err == nil {
			return v, nil
		} else if !errors.Is(err, store.ErrNotFound) {
			return v, err
		}
	}
	return store.KnowledgeVault{}, refuse(store.PersonalAgentRefusalInvalid, http.StatusNotFound, "no memory entry %q in this assistant's layers", spec.Item.ID)
}

// personSaid is what the person wrote in the assistant conversation: each
// input and message steered into a turn, without the server's notices, the
// timers' prompts or Foundry's context for a turn. Tool outputs, files and
// helpers' answers are never inputs.
func (s *Service) personSaid(ctx context.Context, sessionID string, turn store.SessionInput) ([]string, error) {
	session, err := s.store.GetAgentSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	var said []string
	add := func(input store.SessionInput) {
		if text, ok := personalagent.PersonWords(input); ok {
			said = append(said, withoutTurnContext(text))
		}
	}
	for _, event := range session.Events {
		switch {
		case event.Label == store.EventLabelUserMessage && event.Message != nil && event.Message.Kind == "user":
			input := store.SessionInput{Prompt: event.Message.Text}
			if event.Metadata != nil {
				input.TimerFire = event.Metadata.TimerFire
				input.SentBySessionID = event.Metadata.SentBySessionID
			}
			add(input)
		case event.Label == store.EventLabelSteeredIntoTurn:
			input := store.SessionInput{Prompt: event.Detail}
			if event.Metadata != nil {
				input.SentBySessionID = event.Metadata.SentBySessionID
			}
			add(input)
		}
	}
	add(turn)
	return said, nil
}

// withoutTurnContext drops Foundry's context blocks (prompt.TurnContext)
// from a text.
func withoutTurnContext(text string) string {
	for {
		start := strings.Index(text, prompt.TurnContextStart)
		if start < 0 {
			return text
		}
		end := strings.Index(text[start:], prompt.TurnContextEnd)
		if end < 0 {
			return text[:start]
		}
		text = text[:start] + text[start+end+len(prompt.TurnContextEnd):]
	}
}

// planRememberSource writes, corrects or forgets a fact in a layer of the
// assistant's memory (knowledge.EnsureMemoryLayer) or a named domain vault.
func (s *Service) planRememberSource(ctx context.Context, scope Scope, spec memorySpec, item store.PersonalAgentMemoryItem, write Write, note string) (Write, error) {
	if spec.Scope != "" && !knowledge.ValidMemoryScope(spec.Scope) {
		return write, invalid("scope must be assistant or person")
	}
	if spec.Op != "forget" && (item.Status != store.PersonalAgentMemoryActive || item.Origin != store.PersonalAgentMemoryStated) {
		write.Apply = func(context.Context) (any, error) {
			return map[string]string{"status": "needs_confirmation", "note": note}, nil
		}
		return write, nil
	}
	v, err := s.rememberVault(ctx, scope.Agent, spec)
	if err != nil {
		return write, err
	}
	if _, err = s.knowledge.Workspace(ctx, scope.Agent.UserID, v); err != nil {
		return write, err
	}
	if spec.Item.ExpiresAt != "" {
		if _, err = time.Parse(time.RFC3339, spec.Item.ExpiresAt); err != nil {
			return write, invalid("expiresAt requires an RFC3339 timestamp")
		}
	}
	origin := scope.Turn
	if spec.Op != "forget" {
		origin, err = s.personFactSource(ctx, scope, spec.Item.Quote)
		if err != nil {
			return write, err
		}
	}
	sourceInput := origin.ID
	if entry, e := s.store.PersonalAgentInboxByInput(ctx, scope.Agent.ID, origin.ID); e == nil {
		sourceInput = entry.RootID
	}
	key := strings.TrimSpace(spec.Item.IntentKey)
	if key == "" || len(key) > 100 {
		return write, invalid("item.intentKey is required: a stable name for this fact within the person's input")
	}
	id := spec.Item.ID
	revision := int64(0)
	hash := ""
	if spec.Op == "add" {
		if id != "" {
			return write, invalid("add does not accept item.id")
		}
		id = flow.Key("knowledge", v.ID, sourceInput, key)
	} else {
		entry, err := s.store.GetKnowledgeEntry(ctx, scope.Agent.UserID, v.ID, id)
		if err != nil {
			return write, err
		}
		if spec.Item.ExpectedRevision == nil || entry.Revision != *spec.Item.ExpectedRevision || entry.Hash != spec.Item.ExpectedHash {
			return write, invalid("read the source revision and hash before changing it")
		}
		revision, hash = entry.Revision, entry.Hash
	}
	title := strings.TrimSpace(spec.Item.Title)
	if title == "" && spec.Op != "forget" {
		return write, invalid("item.title is required for a knowledge source")
	}
	if len(title) > 200 {
		return write, invalid("knowledge title is too long")
	}
	action := "write"
	if spec.Op == "forget" {
		action = "forget"
	}
	job := store.KnowledgeMutation{ID: flow.Key("kwrite", scope.Agent.UserID, v.ID, sourceInput, key, spec.Op), UserID: scope.Agent.UserID, VaultID: v.ID, EntryID: id, Epoch: v.Epoch, Action: action, ExpectedRevision: revision, ExpectedHash: hash, Title: title, Body: item.Content, SourceRef: "session:" + scope.SessionID + "/event/evt_" + origin.ID, SourceVersion: origin.At, ExpiresAt: spec.Item.ExpiresAt}
	intent := job
	intent.Epoch = 0 // Location changes do not change the user's fact intent.
	fingerprint, err := flow.Fingerprint(struct {
		Body     string
		Mutation store.KnowledgeMutation
	}{job.Body, intent})
	if err != nil {
		return write, err
	}
	job.RequestHash = fingerprint
	write.Apply = func(ctx context.Context) (any, error) {
		saved, err := s.store.CaptureKnowledgeMutation(ctx, job)
		if err != nil {
			return nil, err
		}
		answer := map[string]any{"status": "captured", "operation": saved, "vaultId": v.ID, "note": "The owner file write is durable but may be waiting for its device. This does not publish the fact to another account or workspace."}
		if v.Scope != "" {
			answer["scope"] = v.Scope
		}
		return answer, nil
	}
	return write, nil
}

// Resolve the actual user event, not the later notice that happened to recall
// it. Stable origin identity also prevents repeated notices duplicating a fact.
func (s *Service) personFactSource(ctx context.Context, scope Scope, quote string) (store.SessionInput, error) {
	matches := func(input store.SessionInput) bool {
		words, ok := personalagent.PersonWords(input)
		return ok && personalagent.QuoteGrounded(quote, []string{withoutTurnContext(words)})
	}
	if scope.Turn.ID != "" && matches(scope.Turn) {
		return scope.Turn, nil
	}
	session, err := s.store.GetAgentSession(ctx, scope.SessionID)
	if err != nil {
		return store.SessionInput{}, err
	}
	for i := len(session.Events) - 1; i >= 0; i-- {
		event := session.Events[i]
		var input store.SessionInput
		switch {
		case event.Label == store.EventLabelUserMessage && event.Message != nil && event.Message.Kind == "user":
			input = store.SessionInput{ID: event.Message.ID, Prompt: event.Message.Text, At: event.At}
		case event.Label == store.EventLabelSteeredIntoTurn:
			inputID, _ := store.SessionInputIDOfEvent(event.ID)
			input = store.SessionInput{ID: inputID, Prompt: event.Detail, At: event.At}
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
