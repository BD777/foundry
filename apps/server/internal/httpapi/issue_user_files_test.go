package httpapi

import (
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestIssueUserFilesOnlyForTheDeviceOwnersIssues(t *testing.T) {
	owner := Actor{Kind: ActorDaemon, DeviceID: "dev_1", Account: &store.User{ID: "user_owner"}}
	cases := []struct {
		name    string
		creator string
		device  Actor
		want    string
	}{
		{"owner started it", "user_owner", owner, "readable"},
		{"a teammate started it", "user_teammate", owner, "hidden"},
		{"creator unknown", "", owner, "hidden"},
		{"device without an owner", "", Actor{Kind: ActorDaemon, DeviceID: "dev_1"}, "hidden"},
	}
	for _, c := range cases {
		got := issueUserFiles(store.Issue{CreatedByUserID: c.creator}, c.device)
		if got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
