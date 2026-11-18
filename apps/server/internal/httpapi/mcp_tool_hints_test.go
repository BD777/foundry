package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

// mcpToolCategories is the category tree agents search Foundry tools by. Each
// tool's anthropic/searchHint starts with one of these labels; the list is
// documented in docs/where-things-live.md.
var mcpToolCategories = []string{
	"sessions & work:",
	"workspaces & skills:",
	"devices & resources:",
	"connectors & accounts:",
	"models & execution:",
	"person list & memory:",
	"issues & knowledge:",
	"assistant settings:",
	"foundry settings:",
}

// mcpAlwaysLoaded are the only Foundry tools whose schemas Claude Code loads
// up front (anthropic/alwaysLoad); every other tool stays behind tool search.
var mcpAlwaysLoaded = []string{"list_sessions", "needs_you", "send_message"}

const mcpSearchHintMaxBytes = 120

type mcpToolMeta struct {
	SearchHint string `json:"anthropic/searchHint"`
	AlwaysLoad bool   `json:"anthropic/alwaysLoad"`
}

func TestEveryFoundryToolHasACategorySearchHint(t *testing.T) {
	alwaysLoaded := []string{}
	for _, tool := range remoteMCPTools {
		var definition struct {
			Meta mcpToolMeta `json:"_meta"`
		}
		if err := json.Unmarshal(tool.definition, &definition); err != nil {
			t.Fatalf("%s: %v", tool.name, err)
		}
		hint := definition.Meta.SearchHint
		if hint == "" {
			t.Errorf("%s has no anthropic/searchHint", tool.name)
			continue
		}
		if !slices.ContainsFunc(mcpToolCategories, func(category string) bool { return strings.HasPrefix(hint, category+" ") }) {
			t.Errorf("%s searchHint %q does not start with a category in mcpToolCategories", tool.name, hint)
		}
		if len(hint) > mcpSearchHintMaxBytes {
			t.Errorf("%s searchHint is %d bytes, want at most %d", tool.name, len(hint), mcpSearchHintMaxBytes)
		}
		if definition.Meta.AlwaysLoad {
			alwaysLoaded = append(alwaysLoaded, tool.name)
		}
	}
	want := slices.Clone(mcpAlwaysLoaded)
	slices.Sort(want)
	slices.Sort(alwaysLoaded)
	if !slices.Equal(alwaysLoaded, want) {
		t.Fatalf("always-loaded tools %v, want exactly %v", alwaysLoaded, want)
	}
}

func TestToolsListSendsSearchHintsAndAlwaysLoadUnchanged(t *testing.T) {
	db, chat := lineageFixture(t)
	token, err := db.MintAgentSessionToken(context.Background(), chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	listed := mcpListedToolDefinitions(t, NewServer(db).Routes(), token)

	catalog := map[string]json.RawMessage{}
	for _, tool := range remoteMCPTools {
		catalog[tool.name] = tool.definition
	}
	for _, name := range []string{"send_message", "list_sessions"} {
		if _, ok := listed[name]; !ok {
			t.Fatalf("a chat does not list %s, so its alwaysLoad cannot be checked", name)
		}
	}
	for name, definition := range listed {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(definition, &fields); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for _, people := range mcpToolPeopleFields {
			if _, leaked := fields[people]; leaked {
				t.Errorf("%s sends the people-only field %q to agents", name, people)
			}
		}
		var sent, source struct {
			Meta mcpToolMeta `json:"_meta"`
		}
		if err := json.Unmarshal(definition, &sent); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if err := json.Unmarshal(catalog[name], &source); err != nil {
			t.Fatalf("%s catalog: %v", name, err)
		}
		if sent.Meta != source.Meta {
			t.Errorf("%s sends _meta %+v, catalog has %+v", name, sent.Meta, source.Meta)
		}
		if sent.Meta.AlwaysLoad != slices.Contains(mcpAlwaysLoaded, name) {
			t.Errorf("%s alwaysLoad = %v, want %v", name, sent.Meta.AlwaysLoad, slices.Contains(mcpAlwaysLoaded, name))
		}
	}
}

// mcpListedToolDefinitions returns the raw definition tools/list sends to a
// bearer token, keyed by tool name.
func mcpListedToolDefinitions(t *testing.T, handler http.Handler, token string) map[string]json.RawMessage {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var envelope struct {
		Result struct {
			Tools []json.RawMessage `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("tools/list: %d %s", response.Code, response.Body.String())
	}
	definitions := map[string]json.RawMessage{}
	for _, raw := range envelope.Result.Tools {
		var named struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(raw, &named); err != nil || named.Name == "" {
			t.Fatalf("tools/list entry without a name: %s", raw)
		}
		definitions[named.Name] = raw
	}
	return definitions
}
