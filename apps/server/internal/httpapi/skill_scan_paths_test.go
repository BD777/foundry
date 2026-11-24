package httpapi

import (
	"context"
	"slices"
	"testing"
)

func TestDeviceScanUsesOnlyDeviceRoots(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	paths, err := fixture.server.scanPaths(context.Background(), fixture.deviceID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(paths, defaultSkillRoots) {
		t.Fatalf("scan roots = %v, want %v", paths, defaultSkillRoots)
	}
}
