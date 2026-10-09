package skillarchive

import (
	"reflect"
	"testing"
)

func TestToolRequirements(t *testing.T) {
	manifest := "---\nname: demo\nmetadata:\n  requires: ffmpeg, python\n---\n"
	files := map[string][]byte{
		"scripts/a.py":   []byte("print(1)"),
		"scripts/run":    []byte("#!/usr/bin/env -S node --no-warnings\n"),
		"scripts/b.sh":   []byte("#!/bin/sh\n"),
		"tools/x":        []byte("#!/usr/bin/env $(rm -rf /)\n"),
		"reference.md":   []byte("#!/usr/bin/env nothing-in-markdown"),
		"assets/logo.js": []byte("x"),
	}
	got := ToolRequirements(manifest, files)
	want := []string{"bash", "ffmpeg", "node", "python3"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("requirements %v, want %v", got, want)
	}
	listed := ToolRequirements("---\nname: d\nmetadata:\n  requires: [jq, \"bad name\", rg]\n---\n", nil)
	if !reflect.DeepEqual(listed, []string{"jq", "rg"}) {
		t.Fatalf("list form %v", listed)
	}
}
