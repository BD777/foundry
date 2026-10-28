package store

import (
	"encoding/json"
	"testing"
)

// The device says whether a change has a text diff; the server keeps it so
// the Web knows before asking (DEV-064).
func TestSessionFileRecordKeepsDiffAvailability(t *testing.T) {
	worker := `{"sessionFile":{"path":"/w/data.bin","origin":"tool","op":"modified","inGitRepo":true,"diff":"binary","totalDiff":"binary"}}`
	var metadata AgentSessionEventMetadata
	if err := json.Unmarshal([]byte(worker), &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata.SessionFile == nil || metadata.SessionFile.Diff != "binary" || metadata.SessionFile.TotalDiff != "binary" {
		t.Fatalf("decoded %+v", metadata.SessionFile)
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	var again map[string]map[string]any
	if err := json.Unmarshal(encoded, &again); err != nil {
		t.Fatal(err)
	}
	if again["sessionFile"]["diff"] != "binary" || again["sessionFile"]["totalDiff"] != "binary" {
		t.Fatalf("encoded %s", encoded)
	}
	// Older devices send neither; nothing is invented.
	older, _ := json.Marshal(SessionFileRecord{Path: "/w/a.go", Origin: "reference", Op: "referenced"})
	var plain map[string]any
	_ = json.Unmarshal(older, &plain)
	if _, ok := plain["diff"]; ok {
		t.Fatalf("older record gained a diff: %s", older)
	}
}
