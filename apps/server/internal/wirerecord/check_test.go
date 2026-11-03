package wirerecord

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

type checkReplyError struct {
	Error string `json:"error,omitempty"`
}

type checkItem struct {
	Name string `json:"name"`
	Size int64  `json:"size,omitempty"`
}

type checkPayload struct {
	ID       string            `json:"id"`
	Count    int               `json:"count"`
	Ratio    float64           `json:"ratio,omitempty"`
	At       time.Time         `json:"at,omitzero"`
	Items    []checkItem       `json:"items"`
	Tags     []string          `json:"tags,omitempty"`
	Labels   map[string]string `json:"labels,omitempty"`
	Optional *checkItem        `json:"optional,omitempty"`
	Raw      json.RawMessage   `json:"raw,omitempty"`
	Data     []byte            `json:"data,omitempty"`
	Ignored  string            `json:"-"`
	checkReplyError
}

func issuesOf(t *testing.T, value string) []string {
	t.Helper()
	decoded, err := Decode(json.RawMessage(value))
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, issue := range CheckGo(reflect.TypeFor[checkPayload](), decoded, "payload") {
		out = append(out, issue.Kind+" "+issue.Path+" "+issue.Detail)
	}
	slices.Sort(out)
	return out
}

func TestCheckGoAcceptsWhatTheTypeDeclares(t *testing.T) {
	got := issuesOf(t, `{"id":"a","count":2,"ratio":0.5,"at":"2026-11-03T10:00:00Z","items":[{"name":"x","size":3}],
		"tags":["t"],"labels":{"k":"v"},"optional":null,"raw":{"any":[1]},"data":"aGk=","error":"refused"}`)
	if len(got) != 0 {
		t.Fatalf("issues = %q", got)
	}
	// A placeholder stands in for a value it took out, whatever its form.
	if got := issuesOf(t, `{"id":"a","count":1,"items":[],"at":"‹string 80 bytes›","data":"‹text 9 bytes›"}`); len(got) != 0 {
		t.Fatalf("placeholders = %q", got)
	}
}

func TestCheckGoFindsDrift(t *testing.T) {
	got := issuesOf(t, `{"Id":"a","count":1.5,"items":null,"tags":[1],"labels":{"k":2},"extra":{"x":1},
		"optional":{"name":"n","more":true},"at":"yesterday","Ignored":"x"}`)
	want := []string{
		`missing payload.id string`,
		`null payload.items null for []wirerecord.checkItem`,
		`type payload.at string for time.Time`,
		`type payload.count 1.5 for int`,
		`type payload.labels{} integer for string`,
		`type payload.tags[] integer for string`,
		`unknown payload.Id encoding/json takes it as "id" (case-insensitive)`,
		`unknown payload.Ignored `,
		`unknown payload.extra `,
		`unknown payload.optional.more `,
	}
	slices.Sort(want)
	for i, line := range got {
		// The parse error's wording is time's, not ours.
		got[i], _, _ = strings.Cut(line, ": ")
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("issues:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestReportCountsIssuesOncePerSample(t *testing.T) {
	report := NewReport()
	issue := Issue{Kind: "unknown", Path: "payload.items[].x"}
	report.Add(Record{Channel: "ws", Dir: "in", Kind: "k", Shape: "a"}, "T", "", []Issue{issue, issue})
	report.Add(Record{Channel: "ws", Dir: "in", Kind: "k", Shape: "b", Error: "e"}, "T", "", []Issue{issue})
	report.Add(Record{Channel: "rest", Kind: "GET /x", Shape: "a", Status: 200}, "", "no type", nil)
	kinds := report.Kinds()
	if len(kinds) != 2 || kinds[0].Channel != "rest" || kinds[0].Statuses["200"] != 1 || kinds[0].Unchecked != "no type" {
		t.Fatalf("kinds = %+v", kinds)
	}
	ws := kinds[1]
	if ws.Samples != 2 || ws.Shapes != 2 || ws.Errors != 1 || len(ws.Issues) != 1 || ws.Issues[0].Samples != 2 {
		t.Fatalf("ws = %+v", ws)
	}
}
