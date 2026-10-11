package browserevent

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// fixturePath holds one example of every stream message; the protocol
// package's tests check the same examples against its TypeScript types.
const fixturePath = "../../../../packages/protocol/test/browser-event-fixtures.json"

type fixtureForTest struct {
	Type    Type            `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

func readFixturesForTest(t *testing.T) []fixtureForTest {
	t.Helper()
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []fixtureForTest
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	return fixtures
}

// canonicalForTest is JSON as a reader sees it: member order and spacing
// do not count.
func canonicalForTest(t *testing.T, data []byte) []byte {
	t.Helper()
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return canonical
}

func TestFixturesHoldOneMessageOfEveryType(t *testing.T) {
	var types []Type
	for _, fixture := range readFixturesForTest(t) {
		types = append(types, fixture.Type)
	}
	slices.Sort(types)
	if !slices.Equal(types, Types()) {
		t.Fatalf("fixture types = %v, want each of %v once", types, Types())
	}
}

// Every fixture payload reads into its type's Go payload with no field
// left over and writes back as the same JSON: the Go structs carry exactly
// what browsers are told to expect.
func TestPayloadsMarshalAsTheFixtures(t *testing.T) {
	for _, fixture := range readFixturesForTest(t) {
		payloadType := PayloadType(fixture.Type)
		if payloadType == nil {
			t.Errorf("%s: no payload type", fixture.Type)
			continue
		}
		payload := reflect.New(payloadType)
		decoder := json.NewDecoder(bytes.NewReader(fixture.Payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(payload.Interface()); err != nil {
			t.Errorf("%s: fixture does not read as %s: %v", fixture.Type, payloadType, err)
			continue
		}
		encoded, err := json.Marshal(payload.Elem().Interface())
		if err != nil {
			t.Errorf("%s: %v", fixture.Type, err)
			continue
		}
		if got, want := canonicalForTest(t, encoded), canonicalForTest(t, fixture.Payload); !bytes.Equal(got, want) {
			t.Errorf("%s: %s writes\n%s\nwant the fixture\n%s", fixture.Type, payloadType, got, want)
		}
	}
}

// A kind carries the payload its name registers, and a notice's kind keeps
// snapshots; Define refuses anything else where kinds are defined.
func TestDefineKeepsEachNameToItsPayload(t *testing.T) {
	if kind := Define[store.Issue](IssueUpdated, eventstream.Options{}); kind.Name() != string(IssueUpdated) {
		t.Fatalf("kind name = %q", kind.Name())
	}
	Define[IssueEnvironmentChangedPayload](IssueEnvironmentChanged, eventstream.Options{KeepsSnapshot: true})
	for what, define := range map[string]func(){
		"another payload":                     func() { Define[store.AgentSession](IssueUpdated, eventstream.Options{}) },
		"an unknown name":                     func() { Define[store.Issue](Type("issue_renamed"), eventstream.Options{}) },
		"a notice that invalidates snapshots": func() { Define[IssueEnvironmentChangedPayload](IssueEnvironmentChanged, eventstream.Options{}) },
	} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("Define accepted %s", what)
				}
			}()
			define()
		}()
	}
}
