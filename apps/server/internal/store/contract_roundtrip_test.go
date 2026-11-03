package store

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// TestRecordedModelsRoundTrip checks that the generated models encode recorded values as the
// hand-written types they replaced did. FOUNDRY_MODEL_SAMPLES names a JSONL file of
// {"type", "source", "json", "want"}: json is a recorded value (live DB rows, the device
// traffic recording, connector fixtures) and want what the previous Go type encoded after decoding it. The
// samples hold private data and stay out of the repository; docs/refactor/
// phase6-openapi-design.md says how they were made.
func TestRecordedModelsRoundTrip(t *testing.T) {
	path := os.Getenv("FOUNDRY_MODEL_SAMPLES")
	if path == "" {
		t.Skip("FOUNDRY_MODEL_SAMPLES is not set")
	}
	models := map[string]func() any{
		"AgentProfileProjection":       func() any { return new(AgentProfileProjection) },
		"AgentProjection":              func() any { return new(AgentProjection) },
		"AgentSession":                 func() any { return new(AgentSession) },
		"AgentSessionEvent":            func() any { return new(AgentSessionEvent) },
		"AgentSubagentTranscript":      func() any { return new(AgentSubagentTranscript) },
		"AssetProjection":              func() any { return new(AssetProjection) },
		"ChatThread":                   func() any { return new(ChatThread) },
		"ConnectorDescriptor":          func() any { return new(ConnectorDescriptor) },
		"ConnectorExtensionRepository": func() any { return new(ConnectorExtensionRepository) },
		"ConnectorExtensionSource":     func() any { return new(ConnectorExtensionSource) },
		"ConnectorSignIn":              func() any { return new(ConnectorSignIn) },
		"[]ChatAttachment":             func() any { return new([]ChatAttachment) },
		"CreateAgentProfileInput":      func() any { return new(CreateAgentProfileInput) },
		"DaemonRegistration":           func() any { return new(DaemonRegistration) },
		"DeviceConnectorUse":           func() any { return new(DeviceConnectorUse) },
		"DeviceProjection":             func() any { return new(DeviceProjection) },
		"DeviceRunner":                 func() any { return new(DeviceRunner) },
		"DeviceSkill":                  func() any { return new(DeviceSkill) },
		"ExternalAccountMaterial":      func() any { return new(ExternalAccountMaterial) },
		"Issue":                        func() any { return new(Issue) },
		"NativeAccountHold":            func() any { return new(NativeAccountHold) },
		"NativeArchiveItem":            func() any { return new(NativeArchiveItem) },
		"NativeArchiveTarget":          func() any { return new(NativeArchiveTarget) },
		"ProfileDefinition":            func() any { return new(ProfileDefinition) },
		"ProviderHealth":               func() any { return new(ProviderHealth) },
		"SessionSkillRef":              func() any { return new(SessionSkillRef) },
		"WorkspaceFileEntry":           func() any { return new(WorkspaceFileEntry) },
		"WorkspaceProjection":          func() any { return new(WorkspaceProjection) },
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(nil, 256<<20)
	checked, emptied := map[string]int{}, map[string]int{}
	reached, reachable := map[reflect.Type]bool{}, map[reflect.Type]bool{}
	for scanner.Scan() {
		var sample struct{ Type, Source, JSON, Want string }
		if err := json.Unmarshal(scanner.Bytes(), &sample); err != nil {
			t.Fatal(err)
		}
		model, ok := models[sample.Type]
		if !ok {
			t.Fatalf("no model %s", sample.Type)
		}
		value := model()
		if err := json.Unmarshal([]byte(sample.JSON), value); err != nil {
			t.Fatalf("%s (%s): %v", sample.Type, sample.Source, err)
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if got := string(encoded); got != sample.Want {
			if at, ok := sameButEmptyCollections(got, sample.Want); !ok {
				from := max(0, at-120)
				t.Errorf("%s (%s) encodes differently at byte %d:\n got  …%s\n want …%s", sample.Type, sample.Source, at, got[from:min(len(got), at+80)], sample.Want[from:min(len(sample.Want), at+80)])
			}
			emptied[sample.Type]++
		}
		checked[sample.Type]++
		visitModels(reflect.ValueOf(value), reached)
		visitTypes(reflect.TypeOf(value), reachable)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	var missing []string
	for typ := range reachable {
		if !reached[typ] {
			missing = append(missing, typ.Name())
		}
	}
	sort.Strings(missing)
	t.Logf("checked %v (a nil required collection now [] or {}: %v); %d of %d reachable models carried data; none in the samples: %v", checked, emptied, len(reached), len(reachable), missing)
}

// sameButEmptyCollections compares two encodings token by token, in order, where the
// previous one (want) may have null for a required collection the generated model encodes
// as [] or {} (jsonempty). It returns the byte offset in got of the first other difference.
func sameButEmptyCollections(got, want string) (int, bool) {
	g, w := json.NewDecoder(strings.NewReader(got)), json.NewDecoder(strings.NewReader(want))
	for {
		at := int(g.InputOffset())
		gt, gerr := g.Token()
		wt, werr := w.Token()
		if gerr == io.EOF && werr == io.EOF {
			return 0, true
		}
		if gerr != nil || werr != nil {
			return at, false
		}
		if gt == wt {
			continue
		}
		if open, ok := gt.(json.Delim); ok && wt == nil && (open == '[' || open == '{') {
			if end, err := g.Token(); err == nil && end == json.Delim(map[json.Delim]rune{'[': ']', '{': '}'}[open]) {
				continue
			}
		}
		return at, false
	}
}

// visitModels records the store structs a decoded value holds with at least one field set.
func visitModels(v reflect.Value, seen map[reflect.Type]bool) {
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if !v.IsNil() {
			visitModels(v.Elem(), seen)
		}
	case reflect.Slice, reflect.Array:
		for i := range v.Len() {
			visitModels(v.Index(i), seen)
		}
	case reflect.Map:
		for _, key := range v.MapKeys() {
			visitModels(v.MapIndex(key), seen)
		}
	case reflect.Struct:
		if v.Type().PkgPath() == reflect.TypeOf(AgentSession{}).PkgPath() && !v.IsZero() {
			seen[v.Type()] = true
		}
		for i := range v.NumField() {
			visitModels(v.Field(i), seen)
		}
	}
}

// visitTypes records the store structs a type can hold.
func visitTypes(t reflect.Type, seen map[reflect.Type]bool) {
	switch t.Kind() {
	case reflect.Pointer, reflect.Slice, reflect.Array, reflect.Map:
		visitTypes(t.Elem(), seen)
	case reflect.Struct:
		if t.PkgPath() != reflect.TypeOf(AgentSession{}).PkgPath() || seen[t] {
			return
		}
		seen[t] = true
		for i := range t.NumField() {
			visitTypes(t.Field(i).Type, seen)
		}
	}
}
