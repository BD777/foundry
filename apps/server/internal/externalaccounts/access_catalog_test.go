package externalaccounts

import (
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Every built-in access file loads, and each level speaks both languages
// the Web ships, so the Connectors page never falls back to a bare name.
func TestAccessCatalogsLoadWithWordsInEveryLanguage(t *testing.T) {
	for _, kind := range []string{"cloudflare", "appstoreconnect"} {
		catalog, err := loadAccessCatalog(kind)
		if err != nil {
			t.Fatal(err)
		}
		for _, level := range catalog.Levels {
			if level.Labels["zh-CN"] == "" || level.Descriptions["zh-CN"] == "" {
				t.Errorf("%s level %s lacks zh-CN words", kind, level.Name)
			}
			if len(level.Scopes) > 0 && level.GrantHints["zh-CN"] == "" {
				t.Errorf("%s level %s names scopes without a zh-CN grant hint", kind, level.Name)
			}
		}
	}
	if got := CloudflareAccess.LevelLabel(CloudflareAccessZeroTrust); got != "Read + DNS edit + Zero Trust" {
		t.Fatalf("zero_trust label %q", got)
	}
	if level, ok := CloudflareAccessLevel(""); !ok || level.Name != CloudflareAccessRead {
		t.Fatalf("default level %+v", level)
	}
}

func TestAccessCatalogRefusesRoutesItCannotEnforce(t *testing.T) {
	levels := []store.ExternalAccessLevel{{Name: "read", Label: "Read", Description: "Reads."}}
	cases := map[string]AccessRoute{
		"unknown level":      {Methods: []string{"GET"}, Path: "/zones/{zone}", Level: "admin"},
		"read with action":   {Methods: []string{"GET"}, Path: "/zones/{zone}", Level: "read", Action: "x"},
		"change, no action":  {Methods: []string{"POST"}, Path: "/zones/{zone}", Level: "read"},
		"unknown identifier": {Methods: []string{"GET"}, Path: "/zones/{name}", Level: "read"},
		"unknown method":     {Methods: []string{"HEAD"}, Path: "/zones/{zone}", Level: "read"},
	}
	for name, route := range cases {
		if err := (AccessCatalog{Levels: levels, Routes: []AccessRoute{route}}).validate(); err == nil {
			t.Errorf("%s: accepted %+v", name, route)
		}
	}
	twice := AccessRoute{Methods: []string{"GET"}, Path: "/zones/{zone}", Level: "read"}
	if err := (AccessCatalog{Levels: levels, Routes: []AccessRoute{twice, twice}}).validate(); err == nil || !strings.Contains(err.Error(), "twice") {
		t.Errorf("a repeated route: %v", err)
	}
	scoped := []store.ExternalAccessLevel{{Name: "edit", Label: "Edit", Description: "Edits.", Scopes: []string{"dns.write"}}}
	if err := (AccessCatalog{Levels: scoped}).validate(); err == nil {
		t.Error("a level with scopes but no grant hint was accepted")
	}
}
