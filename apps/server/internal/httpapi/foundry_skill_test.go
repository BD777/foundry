package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/builtinskills"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Every Foundry tool says, for people, what it does and where it stops, and
// agents are never sent those fields.
func TestEveryFoundryToolHasASummaryAndLimits(t *testing.T) {
	for _, tool := range remoteMCPTools {
		if strings.TrimSpace(tool.summary) == "" || len(tool.summary) > 200 {
			t.Errorf("%s: summary %q, want one line of at most 200 bytes", tool.name, tool.summary)
		}
		if len(tool.limits) == 0 {
			t.Errorf("%s has no limits: name at least whom it reaches", tool.name)
		}
		for _, limit := range tool.limits {
			if strings.TrimSpace(limit) == "" {
				t.Errorf("%s has an empty limit", tool.name)
			}
		}
		var sent map[string]json.RawMessage
		if err := json.Unmarshal(tool.definition, &sent); err != nil {
			t.Fatal(err)
		}
		for _, field := range mcpToolPeopleFields {
			if _, found := sent[field]; found {
				t.Errorf("%s sends agents its %s", tool.name, field)
			}
		}
		if _, found := sent["inputSchema"]; !found {
			t.Errorf("%s lost its input schema", tool.name)
		}
	}
}

// The limits people read name the numbers the server enforces.
func TestFoundryToolLimitsNameTheEnforcedNumbers(t *testing.T) {
	limits := map[string]string{}
	for _, tool := range remoteMCPTools {
		limits[tool.name] = strings.Join(tool.limits, " ")
	}
	attachments := fmt.Sprintf("At most %d attachments, each at most %d MB", maxMCPAttachments, maxMCPAttachmentBytes>>20)
	for tool, want := range map[string][]string{
		"create_session": {attachments, "At most 8 sessions", "at most 4 levels"},
		"send_message":   {attachments},
		"read_context": {
			fmt.Sprintf("maxBytes, %d by default", inspectDefaultBytes),
			fmt.Sprintf("at most %d events", inspectMaxLimit),
			fmt.Sprintf("up to %d events of context", inspectMaxContext),
		},
		"get_session": {
			fmt.Sprintf("cut to %d characters", inspectInputLimit),
			fmt.Sprintf("the answer to %d", inspectAnswerLimit),
		},
		"find_workspace": {fmt.Sprintf("At most %d candidates", personalagent.FindWorkspaceLimit)},
		"get_workspace":  {fmt.Sprintf("at most %d KiB", personalagent.DigestSourceBytes>>10)},
		"remember":       {fmt.Sprintf("at most %d characters", personalagent.MemoryItemMaxChars)},
		"create_workspace": {fmt.Sprintf("At most %d new projects a day and %d a week by default (at most %d and %d)",
			personalagent.DefaultLimits.DailyWorkspaces, personalagent.DefaultLimits.WeeklyWorkspaces,
			personalagent.LimitCaps.DailyWorkspaces, personalagent.LimitCaps.WeeklyWorkspaces)},
	} {
		for _, phrase := range want {
			if !strings.Contains(limits[tool], phrase) {
				t.Errorf("%s limits %q do not say %q", tool, limits[tool], phrase)
			}
		}
	}
}

// The foundry skill's page reads the skill agents get and the tools each
// role is given, from the same rule tools/list applies.
func TestFoundrySkillShowsWhatAgentsGet(t *testing.T) {
	f := newIsolationFixture(t)
	response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/builtin-skills/foundry", ""))
	expectStatus(t, response, http.StatusOK, "the foundry skill")
	var detail store.FoundrySkillDetail
	if err := json.Unmarshal(response.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	skill, _ := builtinskills.Lookup("builtin-claude-foundry")
	if detail.Name != "foundry" || detail.Manifest != skill.Manifest || detail.Description != skill.Description {
		t.Fatalf("detail = %q %q, want the embedded foundry skill", detail.Name, detail.Description)
	}
	if len(detail.Revisions) != 2 || detail.Revisions[0] != (store.BuiltinSkillRevision{Runtime: "claude", Revision: skill.Revision}) || detail.Revisions[1].Runtime != "codex" {
		t.Fatalf("revisions = %+v", detail.Revisions)
	}
	if len(detail.Guidance) == 0 || len(detail.Guidance[0].Points) == 0 {
		t.Fatalf("guidance = %+v", detail.Guidance)
	}
	if len(detail.Tools) != len(remoteMCPTools) {
		t.Fatalf("%d tools, want the catalog's %d", len(detail.Tools), len(remoteMCPTools))
	}
	roles := map[string][]string{}
	for _, tool := range detail.Tools {
		roles[tool.Name] = tool.Roles
		if tool.Summary == "" || len(tool.Limits) == 0 {
			t.Errorf("%s has no summary or limits", tool.Name)
		}
	}
	for tool, want := range map[string][]string{
		"read_context":     {"session", "issue_execution", "issue_clarification", "verifier", "personal_agent"},
		"get_issue":        {"session", "issue_execution", "verifier", "personal_agent"},
		"create_session":   {"session", "issue_execution", "personal_agent"},
		"ask_person":       {"issue_execution"},
		"acquire_resource": {"session", "issue_execution"},
		"feishu_events":    {"session", "issue_execution"},
		"remember":         {"personal_agent"},
	} {
		if !slices.Equal(roles[tool], want) {
			t.Errorf("%s roles = %v, want %v", tool, roles[tool], want)
		}
	}
}
