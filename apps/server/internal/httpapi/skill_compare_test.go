package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

func comparisonArchive(t *testing.T, files map[string]string) ([]byte, skillarchive.Index) {
	t.Helper()
	var out bytes.Buffer
	z := zip.NewWriter(&out)
	for name, body := range files {
		w, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(body))
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	idx, err := skillarchive.Inspect(out.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	return out.Bytes(), idx
}
func TestSkillComparisonUsesCachedManifestAndReadsOnlySelectedFile(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	server := NewServer(db)
	old, _ := comparisonArchive(t, map[string]string{"SKILL.md": "old\n", "unchanged.txt": "same"})
	_, next := comparisonArchive(t, map[string]string{"SKILL.md": "new\n", "unchanged.txt": "same", "binary.png": "\x00PNG"})
	target, _, err := db.AddPromotedSkillRevision(ctx, store.PromoteSkillInput{DeviceID: "dev_compare", Root: "/skills", DirName: "demo"}, "demo", "", old, 2)
	if err != nil {
		t.Fatal(err)
	}
	source := store.DeviceSkill{Name: "demo", Root: "/skills", DirName: "demo", SourceDigest: next.SourceDigest, Manifest: next.Files, DependenciesAnalyzed: true}
	if err = db.ReplaceDeviceSkills(ctx, store.ReplaceDeviceSkillsInput{DeviceID: "dev_compare", Skills: []store.DeviceSkill{source}}); err != nil {
		t.Fatal(err)
	}
	input := store.SkillComparisonInput{DeviceID: "dev_compare", Root: "/skills", DirName: "demo", SkillID: target.ID, Revision: 1, SourceDigest: next.SourceDigest}
	body, _ := json.Marshal(input)
	// There is no daemon. Listing changes must be a pure metadata read.
	response := requestForTest(t, server, http.MethodPost, "/api/skills/compare", string(body), http.StatusOK)
	var view struct {
		Files     []skillFileChange `json:"files"`
		Unchanged int               `json:"unchanged"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if len(view.Files) != 2 || view.Unchanged != 1 {
		t.Fatalf("unexpected manifest comparison: %s", response.Body.String())
	}
	input.Path = "binary.png"
	body, _ = json.Marshal(input)
	response = requestForTest(t, server, http.MethodPost, "/api/skills/compare-file", string(body), http.StatusOK)
	if !strings.Contains(response.Body.String(), "unavailable") {
		t.Fatal("binary file attempted text rendering")
	}
	// Historical server downloads are also available without the source device.
	input.Side = "server"
	body, _ = json.Marshal(input)
	response = requestForTest(t, server, http.MethodPost, "/api/skills/compare-package", string(body), http.StatusOK)
	if !bytes.Equal(response.Body.Bytes(), old) {
		t.Fatal("download did not preserve immutable revision")
	}
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	writeWSForTest(t, conn, "hello", map[string]any{"device": map[string]any{"id": "dev_compare", "label": "Compare test", "status": "connected"}, "workspace": map[string]any{"id": "ws_compare", "name": "Compare test", "localPath": "/tmp/compare", "baseline": "main"}})
	readWSTypeForTest(t, conn, "registered")
	var reads atomic.Int32
	var stale atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			var req wsEnvelope
			if conn.ReadJSON(&req) != nil {
				return
			}
			if req.Type != wsReadSkillFileType {
				continue
			}
			reads.Add(1)
			text := "new\n"
			if stale.Load() {
				text = "changed after scan"
			}
			sum := sha256.Sum256([]byte(text))
			raw, _ := json.Marshal(wsSkillFileReadPayload{Content: text, Digest: hex.EncodeToString(sum[:])})
			if conn.WriteJSON(wsEnvelope{ID: req.ID, Type: wsSkillFileReadType, Payload: raw}) != nil {
				return
			}
		}
	}()
	input.Path = "SKILL.md"
	body, _ = json.Marshal(input)
	response = requestForTest(t, server, http.MethodPost, "/api/skills/compare-file", string(body), http.StatusOK)
	var contents map[string]string
	json.Unmarshal(response.Body.Bytes(), &contents)
	if contents["before"] != "old\n" || contents["after"] != "new\n" || reads.Load() != 1 {
		t.Fatalf("bad file comparison: %s", response.Body.String())
	}
	input.Path = "../outside"
	body, _ = json.Marshal(input)
	requestForTest(t, server, http.MethodPost, "/api/skills/compare-file", string(body), http.StatusNotFound)
	if reads.Load() != 1 {
		t.Fatal("unindexed file was requested from worker")
	}
	stale.Store(true)
	input.Path = "SKILL.md"
	body, _ = json.Marshal(input)
	requestForTest(t, server, http.MethodPost, "/api/skills/compare-file", string(body), http.StatusConflict)
	conn.Close()
	<-done
}
