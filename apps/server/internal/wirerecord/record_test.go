package wirerecord

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readRecords(t *testing.T, path string) []Record {
	t.Helper()
	var records []Record
	if err := Read(path, func(record Record) error {
		records = append(records, record)
		return nil
	}); err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return records
}

func openForTest(t *testing.T, dir string, limits Limits) *Recorder {
	t.Helper()
	recorder, err := Open(dir, limits)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = recorder.Close() })
	return recorder
}

// Secrets planted in every place a device or the server puts one never
// reach the file, and what is left keeps the payload's shape.
func TestRecordingNeverWritesSecretsOrContents(t *testing.T) {
	dir := t.TempDir()
	recorder := openForTest(t, dir, DefaultLimits)
	planted := map[string]string{
		"device credential":   "fdyd_8f3Kq9ZpLm2Xv7Rt4Wn6Yb1Hc5Jd0Ge",
		"session token":       "fdys_Q2w9E8r7T6y5U4i3O2p1A0sDfGhJkL",
		"pairing token":       "pair-7f1c2d9e8b3a4c5d",
		"api key":             "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv",
		"provider env":        "env-secret-value-0042",
		"authorization":       "Basic dXNlcjpodW50ZXIy",
		"cookie":              "foundry_session=Zx81Kq",
		"client secret":       "cs_9d8c7b6a",
		"password":            "hunter2-correct-horse",
		"attachment content":  "QkVHSU4gUFJJVkFURSBDT05URU5UUw==",
		"file content":        "export AWS_SECRET=shhh-file",
		"bearer in error":     "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXYifQ.c2lnbmF0dXJlLXZhbHVl",
		"token in url":        "tok_in_query_51723",
		"github token inline": "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123",
	}
	payload := map[string]any{
		"device": map[string]any{"id": "dev_1", "credential": planted["device credential"]},
		"session": map[string]any{
			"sessionToken": planted["session token"],
			"profile": map[string]any{
				"apiKey": planted["api key"],
				"env":    map[string]string{"ANTHROPIC_API_KEY": planted["provider env"]},
			},
		},
		"headers":         map[string]string{"Authorization": planted["authorization"], "Cookie": planted["cookie"]},
		"clientSecret":    planted["client secret"],
		"password":        planted["password"],
		"dataBase64":      planted["attachment content"],
		"content":         planted["file content"],
		"url":             "https://example.test/x?token=" + planted["token in url"],
		"note":            planted["github token inline"],
		"count":           3,
		"inputTokens":     1200,
		"hasCredential":   true,
		"status":          "running",
		"emptyCredential": "",
	}
	raw, _ := json.Marshal(payload)
	recorder.Envelope("in", "dev_1", "hello", "h1", "auth failed: Bearer "+planted["bearer in error"], raw)
	recorder.HTTP("POST /api/daemon/pair", 201,
		[]byte(`{"token":"`+planted["pairing token"]+`","deviceId":"dev_1","workerFingerprint":"fp"}`),
		[]byte(`{"deviceId":"dev_1","credential":"`+planted["device credential"]+`"}`), "")
	if err := recorder.Close(); err != nil {
		t.Fatal(err)
	}

	written, err := os.ReadFile(filepath.Join(dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	for what, secret := range planted {
		if strings.Contains(string(written), secret) {
			t.Errorf("the %s was written: %s", what, written)
		}
	}
	records := readRecords(t, filepath.Join(dir, FileName))
	if len(records) != 2 {
		t.Fatalf("records = %d, want 2", len(records))
	}
	hello, _ := Decode(records[0].Payload)
	object := hello.(map[string]any)
	// Structure, types, enum values and empty strings stay.
	if object["status"] != "running" || object["hasCredential"] != true || object["emptyCredential"] != "" ||
		fmt.Sprint(object["inputTokens"]) != "1200" {
		t.Fatalf("kept values changed: %v", object)
	}
	if got := object["dataBase64"]; got != "‹text 32 bytes›" {
		t.Fatalf("attachment content = %v", got)
	}
	env := object["session"].(map[string]any)["profile"].(map[string]any)["env"].(map[string]any)
	if _, ok := env["ANTHROPIC_API_KEY"]; !ok {
		t.Fatalf("env names are structure and stay: %v", env)
	}
	if records[1].Status != 201 || records[1].Kind != "POST /api/daemon/pair" || len(records[1].Response) == 0 {
		t.Fatalf("rest record = %+v", records[1])
	}
}

// The first PerKind messages of a kind are kept, then only new shapes among
// every ShapeEvery-th, up to ShapesPerKind; long strings and lists are cut.
func TestRecordingIsBoundedPerKindAndInSize(t *testing.T) {
	dir := t.TempDir()
	limits := Limits{PerKind: 3, ShapeEvery: 2, ShapesPerKind: 2, MaxFileBytes: 1 << 20, MaxBodyBytes: 4096, MaxStringBytes: 16, ArrayHead: 2, ArrayMax: 4}
	recorder := openForTest(t, dir, limits)
	same := []byte(`{"id":"a"}`)
	for range 20 {
		recorder.Envelope("in", "dev", "heartbeat", "", "", same)
	}
	for i := range 20 {
		// A new shape every time; only every second one is looked at.
		recorder.Envelope("out", "dev", "session_event", "", "", fmt.Appendf(nil, `{"f%d":1}`, i))
	}
	recorder.Envelope("out", "dev", "big", "", "", []byte(`{"pad":"`+strings.Repeat("x", 5000)+`"}`))
	recorder.Envelope("out", "dev", "list", "", "", []byte(`{"long":"`+strings.Repeat("y", 40)+`","items":[1,2,3,4,"a",{"k":1},true,null]}`))
	if err := recorder.Close(); err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	var big, list Record
	for _, record := range readRecords(t, filepath.Join(dir, FileName)) {
		counts[record.Dir+" "+record.Kind]++
		switch record.Kind {
		case "big":
			big = record
		case "list":
			list = record
		}
	}
	if counts["in heartbeat"] != 3 {
		t.Fatalf("heartbeats kept = %d, want PerKind 3", counts["in heartbeat"])
	}
	if counts["out session_event"] != 5 {
		t.Fatalf("session events kept = %d, want 3 + 2 new shapes", counts["out session_event"])
	}
	if big.Payload != nil || big.Omitted == "" || big.Bytes != 5010 {
		t.Fatalf("an oversized body is recorded by its size only: %+v", big)
	}
	if got := string(list.Payload); got != `{"items":[1,2,"a",{"k":1}],"long":"‹string 40 bytes›"}` {
		t.Fatalf("list = %s", got)
	}

	// A file at its limit takes nothing more, and a reopened recording
	// counts what is already kept.
	reopened := openForTest(t, dir, limits)
	reopened.Envelope("in", "dev", "heartbeat", "", "", same)
	_ = reopened.Close()
	if n := len(readRecords(t, filepath.Join(dir, FileName))); n != 10 {
		t.Fatalf("records after reopening = %d, want 10", n)
	}
	tiny := openForTest(t, t.TempDir(), Limits{PerKind: 100, ShapeEvery: 1, ShapesPerKind: 1, MaxFileBytes: 400, MaxBodyBytes: 4096, MaxStringBytes: 16, ArrayHead: 2, ArrayMax: 4})
	for range 50 {
		tiny.Envelope("in", "dev", "heartbeat", "", "", same)
	}
	_ = tiny.Close()
	if info, err := os.Stat(tiny.Path()); err != nil || info.Size() > 400 {
		t.Fatalf("file past its limit: %v %v", info.Size(), err)
	}
}

func TestNilRecorderRecordsNothing(t *testing.T) {
	var recorder *Recorder
	recorder.Envelope("in", "dev", "hello", "", "", []byte(`{}`))
	recorder.HTTP("GET /x", 200, nil, nil, "")
	if recorder.Wants() || recorder.Close() != nil || recorder.Path() != "" {
		t.Fatal("a nil recorder must do nothing")
	}
}

func TestReadStopsAtATornLastLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	if err := os.WriteFile(path, []byte(`{"channel":"ws","dir":"in","kind":"hello","shape":"a"}`+"\n"+`{"channel":"ws","di`), 0o600); err != nil {
		t.Fatal(err)
	}
	if records := readRecords(t, path); len(records) != 1 || records[0].Kind != "hello" {
		t.Fatalf("records = %+v", records)
	}
}
