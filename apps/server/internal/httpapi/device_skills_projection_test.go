package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Workspace data, refetched every few seconds, leaves device skill lists out
// (hundreds of skills per device). Each device carries a skillsVersion
// instead, and its list loads from /api/device-skills.
func TestFoundryDataLeavesDeviceSkillListsOut(t *testing.T) {
	db := newTestStore(t)
	server := NewServer(db)
	ctx := context.Background()
	const description = "a long description only the skill list carries"
	scan := func() {
		t.Helper()
		if err := db.ReplaceDeviceSkills(ctx, store.ReplaceDeviceSkillsInput{DeviceID: "dev_mbp", Skills: []store.DeviceSkill{
			{Root: "/skills", DirName: "alpha", Name: "alpha", Description: description},
		}}); err != nil {
			t.Fatalf("scan: %v", err)
		}
		server.invalidateProjections()
	}
	skillsVersion := func() string {
		t.Helper()
		body := requestForTest(t, server, http.MethodGet, "/api/foundry-data?workspaceId=ws_atlas", "", http.StatusOK).Body.Bytes()
		var keys map[string]json.RawMessage
		if err := json.Unmarshal(body, &keys); err != nil {
			t.Fatalf("decode foundry-data: %v", err)
		}
		if _, ok := keys["deviceSkills"]; ok {
			t.Fatal("foundry-data still carries deviceSkills")
		}
		if strings.Contains(string(body), description) {
			t.Fatal("foundry-data carries a scanned skill")
		}
		var devices []store.DeviceProjection
		if err := json.Unmarshal(keys["devices"], &devices); err != nil {
			t.Fatalf("decode devices: %v", err)
		}
		for _, device := range devices {
			if device.ID == "dev_mbp" {
				if device.SkillsVersion == "" {
					t.Fatal("dev_mbp has no skillsVersion")
				}
				return device.SkillsVersion
			}
		}
		t.Fatalf("dev_mbp missing from %+v", devices)
		return ""
	}

	scan()
	first := skillsVersion()
	if again := skillsVersion(); again != first {
		t.Fatalf("skillsVersion moved without a change: %q -> %q", first, again)
	}

	var listed struct {
		Skills []store.DeviceSkill `json:"skills"`
	}
	response := requestForTest(t, server, http.MethodGet, "/api/device-skills?deviceId=dev_mbp", "", http.StatusOK)
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode device skills: %v", err)
	}
	if len(listed.Skills) != 1 || listed.Skills[0].Description != description {
		t.Fatalf("device skills = %+v", listed.Skills)
	}

	scan()
	if next := skillsVersion(); next == first {
		t.Fatalf("skillsVersion did not move after a scan: %q", next)
	}
}
