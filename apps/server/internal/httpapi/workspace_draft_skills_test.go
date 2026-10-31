package httpapi

import (
	"context"
	"testing"
)

func TestWorkspaceDraftViewDoesNotClaimAnOfflineWorkerSupportsDrafts(t *testing.T) {
	f := setupProjectedSessionFixture(t)
	view, err := f.server.workspaceDraftView(context.Background(), f.workspace.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if view.Supported {
		t.Fatal("offline worker reported supported")
	}
	if _, err = f.server.workspaceDraftView(context.Background(), f.workspace.ID, true); err == nil {
		t.Fatal("offline refresh succeeded")
	}
}
