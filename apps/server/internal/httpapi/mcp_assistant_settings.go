package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// assistant_settings (docs/personal-agent.md §5, DEV-298) lets the person's
// assistant read its notice, digest, hours, interface and model settings,
// change them under the class table (personalagent/assistant_settings.go),
// and test its notice connector. Updates run through the assistant's write
// pipeline; the notice calls run the functions the Settings routes run.

// noticeTestWindow and noticeTestMax bound the test notices one assistant
// sends: enough to check the connection, not a way to message the person.
const (
	noticeTestWindow = 10 * time.Minute
	noticeTestMax    = 3
)

// noticeTestLimiter counts each assistant's recent test notices. It is kept
// in memory, so a restart starts the count again.
type noticeTestLimiter struct {
	mu   sync.Mutex
	sent map[string][]time.Time
}

// allow records one test notice for the assistant when the window has room.
func (l *noticeTestLimiter) allow(assistantID string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.sent == nil {
		l.sent = map[string][]time.Time{}
	}
	recent := slices.DeleteFunc(l.sent[assistantID], func(at time.Time) bool { return now.Sub(at) >= noticeTestWindow })
	if len(recent) >= noticeTestMax {
		l.sent[assistantID] = recent
		return false
	}
	l.sent[assistantID] = append(recent, now)
	return true
}

// assistantSettingSections are the groups get answers. Each names the fields
// it shows; the full set and their classes are in every answer.
var assistantSettingSections = []struct {
	name   string
	fields []string
}{
	{"notify", []string{"notify"}},
	{"quietHours", []string{"activeHoursStart", "activeHoursEnd", "urgentAnytime"}},
	{"digest", []string{"dailyDigest", "dailyDigestTime"}},
	{"interface", []string{"homePage", "simpleInterface"}},
	{"models", []string{"assistantModel", "delegateModel", "assistantProfileId"}},
	{"feishu", []string{"feishuDirectChat", "feishuAppId"}},
}

// assistantSettingsForMCP answers assistant_settings for the calling
// assistant conversation.
func (s *Server) assistantSettingsForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	scope, err := s.paScope(ctx, call.actor)
	if err != nil {
		return "", err
	}
	switch op := mcpArgString(call.args, "op"); op {
	case "get":
		return assistantSettingsGet(scope.Agent, mcpArgList(call.args, "sections"))
	case "update":
		answer, err := s.assistant.RunTool(ctx, scope, "update_settings", call.args)
		if err != nil {
			return "", err
		}
		return encodeJSON(answer)
	case "notify_instances":
		return s.assistantNotifyInstances(ctx, scope.Agent)
	case "notify_find_chat":
		return s.assistantNotifyFindChat(ctx, scope.Agent, call.args)
	case "notify_test":
		return s.assistantNotifyTest(ctx, scope.Agent, call.args)
	default:
		return "", invalid("op is get, update, notify_instances, notify_find_chat or notify_test, not %q", op)
	}
}

// assistantSettingsGet answers the chosen sections (all by default), the
// settings revision and which fields apply at once.
func assistantSettingsGet(agent store.PersonalAgent, requested []string) (string, error) {
	for _, name := range requested {
		if !slices.Contains(assistantSettingSectionNames(), name) {
			return "", invalid("sections are %s", strings.Join(assistantSettingSectionNames(), ", "))
		}
	}
	values, err := assistantSettingFieldValues(agent)
	if err != nil {
		return "", err
	}
	sections := map[string]map[string]json.RawMessage{}
	for _, section := range assistantSettingSections {
		if len(requested) > 0 && !slices.Contains(requested, section.name) {
			continue
		}
		fields := map[string]json.RawMessage{}
		for _, field := range section.fields {
			fields[field] = values[field]
		}
		sections[section.name] = fields
	}
	return encodeJSON(map[string]any{
		"revision": agent.Settings.Revision,
		"sections": sections,
		"classes": map[string][]string{
			string(personalagent.SettingsImmediate): personalagent.SettingsFieldNames(personalagent.SettingsImmediate),
			string(personalagent.SettingsProposal):  personalagent.SettingsFieldNames(personalagent.SettingsProposal),
		},
	})
}

func assistantSettingSectionNames() []string {
	names := make([]string, 0, len(assistantSettingSections))
	for _, section := range assistantSettingSections {
		names = append(names, section.name)
	}
	return names
}

// assistantSettingFieldValues is every settings field as JSON, by name.
func assistantSettingFieldValues(agent store.PersonalAgent) (map[string]json.RawMessage, error) {
	raw, err := json.Marshal(agent.Settings)
	if err != nil {
		return nil, err
	}
	var values map[string]json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, err
	}
	return values, nil
}

// assistantNotifyInstances is notify_instances: the person's extension
// instances with the reason each cannot carry notices yet (empty when it can),
// so the assistant picks the connectorInstanceId itself.
func (s *Server) assistantNotifyInstances(ctx context.Context, agent store.PersonalAgent) (string, error) {
	instances, err := s.listPersonalAgentNotifyInstances(ctx, agent)
	if err != nil {
		return "", err
	}
	return encodeJSON(map[string]any{"instances": instances})
}

// assistantNotifyFindChat is notify_find_chat: the self-chat discovery the
// Settings route runs, filling the instance's notice chat.
func (s *Server) assistantNotifyFindChat(ctx context.Context, agent store.PersonalAgent, args map[string]json.RawMessage) (string, error) {
	if err := assistant.CheckRunning(agent); err != nil {
		return "", err
	}
	instanceID := strings.TrimSpace(mcpArgString(args, "connectorInstanceId"))
	if instanceID == "" {
		return "", invalid("connectorInstanceId names the connector that takes your notices")
	}
	result, err := s.findPersonalAgentNotifyChat(ctx, agent.UserID, instanceID, strings.TrimSpace(mcpArgString(args, "chatId")))
	if err != nil {
		return "", err
	}
	return encodeJSON(result)
}

// assistantNotifyTest is notify_test: one test notice through the Settings
// route's sender, at most noticeTestMax per noticeTestWindow.
func (s *Server) assistantNotifyTest(ctx context.Context, agent store.PersonalAgent, args map[string]json.RawMessage) (string, error) {
	if err := assistant.CheckRunning(agent); err != nil {
		return "", err
	}
	instanceID := strings.TrimSpace(mcpArgString(args, "connectorInstanceId"))
	if instanceID == "" {
		return "", invalid("connectorInstanceId names the connector that takes your notices")
	}
	if !s.noticeTests.allow(agent.ID, time.Now()) {
		return "", personalagent.Refuse(store.PersonalAgentRefusalLimit, http.StatusTooManyRequests,
			"at most %d test notices in %d minutes: the ones already sent are enough to check the connection", noticeTestMax, int(noticeTestWindow.Minutes()))
	}
	return encodeJSON(s.sendPersonalAgentTestNotice(ctx, agent, instanceID))
}
