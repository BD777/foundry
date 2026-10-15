package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The web gives an assistant without a time zone its browser's; a zone
// already there, the person's choice, is never replaced.
func TestBrowserTimezoneFillsOnlyAnEmptyOne(t *testing.T) {
	f := newAssistantFixture(t)
	fill := func(body string) store.PersonalAgent {
		t.Helper()
		answer := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/personal-agent/timezone", body))
		expectStatus(t, answer, http.StatusOK, "fill "+body)
		var agent store.PersonalAgent
		if err := json.Unmarshal(answer.Body.Bytes(), &agent); err != nil {
			t.Fatal(err)
		}
		return agent
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/personal-agent/timezone", `{"timezone":"Mars/Olympus"}`)),
		http.StatusBadRequest, "an unknown zone")
	expectStatus(t, doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/personal-agent/timezone", body: `{"timezone":"Asia/Tokyo"}`,
		headers: map[string]string{"Authorization": "Bearer " + f.token, "Content-Type": "application/json"}}), http.StatusForbidden, "a session token fills it")
	if agent := fill(`{"timezone":"Europe/Paris"}`); agent.Settings.Timezone != "Europe/Paris" {
		t.Fatalf("empty zone filled = %q", agent.Settings.Timezone)
	}
	if agent := fill(`{"timezone":"Asia/Tokyo"}`); agent.Settings.Timezone != "Europe/Paris" {
		t.Fatalf("a set zone was replaced: %q", agent.Settings.Timezone)
	}
	ctx := context.Background()
	if location := f.server.personLocation(ctx, mustAgent(t, f)); location.String() != "Europe/Paris" {
		t.Fatalf("the person's time zone = %s", location)
	}

	// Stored straight, a zone saved meanwhile also stays.
	agent := mustAgent(t, f)
	agent.Settings.Timezone = "America/New_York"
	if _, err := f.server.store.SavePersonalAgentSettings(ctx, f.aliceID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	if kept, err := f.server.store.FillPersonalAgentTimezone(ctx, f.aliceID, "Asia/Tokyo"); err != nil || kept.Settings.Timezone != "America/New_York" {
		t.Fatalf("store fill over a set zone = %q %v", kept.Settings.Timezone, err)
	}
}

func mustAgent(t *testing.T, f assistantFixture) store.PersonalAgent {
	t.Helper()
	agent, err := f.server.store.GetPersonalAgent(context.Background(), f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	return agent
}
