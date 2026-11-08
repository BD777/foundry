package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// fakeMigrationWorker plays a connected worker: it answers the server's
// requests with answer (nil: no answer) and records what it was asked.
type fakeMigrationWorker struct {
	c      *daemonConnection
	mu     sync.Mutex
	asked  []string
	answer func(w *fakeMigrationWorker, envelope wsEnvelope) any
}

func newFakeMigrationWorker(t *testing.T, s *Server, deviceID, label string, answer func(*fakeMigrationWorker, wsEnvelope) any) *fakeMigrationWorker {
	t.Helper()
	c := newDaemonConnection(s.hub, nil)
	c.deviceID = deviceID
	c.actor = Actor{Kind: ActorDaemon, DeviceID: deviceID}
	c.registration = store.DaemonRegistration{Device: store.DeviceProjection{ID: deviceID, Label: label}}
	s.hub.mu.Lock()
	s.hub.connections[deviceID] = c
	s.hub.mu.Unlock()
	worker := &fakeMigrationWorker{c: c, answer: answer}
	go func() {
		for {
			select {
			case <-c.done:
				return
			case envelope := <-c.send:
				worker.mu.Lock()
				worker.asked = append(worker.asked, envelope.Type)
				worker.mu.Unlock()
				if reply := answer(worker, envelope); reply != nil {
					raw, _ := json.Marshal(reply)
					c.rpc.resolve(envelope.ID, raw)
				}
			}
		}
	}()
	t.Cleanup(func() {
		c.endLifetime()
		close(c.done)
	})
	return worker
}

func (w *fakeMigrationWorker) wasAsked(messageType string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, asked := range w.asked {
		if asked == messageType {
			return true
		}
	}
	return false
}

// news is what the worker reports of a transfer, unasked.
func (w *fakeMigrationWorker) news(envelope wsEnvelope, phase, digest, failure string) {
	var transfer wsWorkspaceMigrationTransferPayload
	_ = json.Unmarshal(envelope.Payload, &transfer)
	payload, _ := json.Marshal(wsWorkspaceMigrationProgressPayload{
		MigrationID: transfer.MigrationID, Role: transfer.Role, Phase: phase, Files: 2, Bytes: 10, TotalFiles: 2, TotalBytes: 10,
		ManifestDigest: digest, Error: failure,
	})
	_ = w.c.onWorkspaceMigrationProgress(context.Background(), wsEnvelope{Type: wsWorkspaceMigrationProgressType, Payload: payload})
}

func registerMigrationWorkspace(t *testing.T, db *sqlitestore.Store) {
	t.Helper()
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_src", Label: "src-box", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_move", Name: "Project", LocalPath: "/src/proj"},
		Agents: []store.AgentProjection{{
			ID: "agent_dev_src_ws_move_claude", WorkspaceID: "ws_move", DeviceID: "dev_src", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_dst", Label: "dst-box", Status: "connected"}}); err != nil {
		t.Fatal(err)
	}
}

// driveMigration runs the driver, waits included, until done says so.
func driveMigration(t *testing.T, s *Server, db *sqlitestore.Store, done func(store.WorkspaceMigrationRecord) bool) store.WorkspaceMigrationRecord {
	t.Helper()
	ctx := context.Background()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		record, err := db.CurrentWorkspaceMigration(ctx, "ws_move")
		if err != nil {
			t.Fatal(err)
		}
		if done(record) {
			return record
		}
		if !store.WorkspaceMigrationEnded(record.State) {
			// What waits for a retry is tried again at once.
			_, _ = db.RenewWorkspaceMigrationLease(ctx, record.ID, "")
		}
		s.drainWorkspaceMigrations(ctx)
		time.Sleep(20 * time.Millisecond)
	}
	record, _ := db.CurrentWorkspaceMigration(ctx, "ws_move")
	t.Fatalf("the move did not get there: %+v", record)
	return record
}

func sourceAnswers(w *fakeMigrationWorker, envelope wsEnvelope) any {
	switch envelope.Type {
	case wsWorkspaceMigrationScanType:
		return wsWorkspaceMigrationScannedPayload{Files: 2, Bytes: 10, ManifestDigest: "digest_1", Warnings: []store.WorkspaceMigrationFolderWarning{{Kind: "external_symlink", Path: "link"}}}
	case wsWorkspaceMigrationTransferType:
		return wsWorkspaceMigrationTransferStartedPayload{}
	case wsWorkspaceMigrationRescanType:
		return wsWorkspaceMigrationRescannedPayload{ManifestDigest: "digest_1"}
	case wsWorkspaceMigrationRetireType:
		return wsReplyError{}
	case wsWorkspaceMigrationPurgeType:
		// A file changed after the move is kept.
		return wsWorkspaceMigrationPurgedPayload{Removed: []string{"/src/proj/a"}, Changed: []string{"/src/proj/b"}, Bytes: 5}
	}
	return nil
}

// targetAnswers receives each transfer once release is closed; the first
// transfer fails when failFirst.
func targetAnswers(release <-chan struct{}, failFirst bool) func(*fakeMigrationWorker, wsEnvelope) any {
	var transfers int
	return func(w *fakeMigrationWorker, envelope wsEnvelope) any {
		switch envelope.Type {
		case wsWorkspaceMigrationCheckType:
			return wsWorkspaceMigrationCheckedPayload{OK: true, FreeBytes: 1 << 40, Path: "/dst/proj"}
		case wsWorkspaceMigrationTransferType:
			transfers++
			attempt := transfers
			go func() {
				if failFirst && attempt == 1 {
					w.news(envelope, "failed", "", "connection reset")
					return
				}
				w.news(envelope, "transferring", "", "")
				<-release
				w.news(envelope, "received", "digest_1", "")
			}()
			return wsWorkspaceMigrationTransferStartedPayload{}
		case wsWorkspaceMigrationVerifyType:
			return wsWorkspaceMigrationVerifiedPayload{OK: true, ManifestDigest: "digest_1"}
		case wsWorkspaceMigrationActivateType:
			return map[string]any{
				"registration": map[string]any{
					"device":    map[string]any{"id": "dev_dst", "label": "dst-box", "status": "connected"},
					"workspace": map[string]any{"id": "ws_move", "name": "Project", "localPath": "/dst/proj"},
				},
				"executionRoot": "/home/dst/.foundry/workspaces/ws_move", "previousExecutionRoot": "/home/src/.foundry/workspaces/ws_move",
			}
		case wsWorkspaceMigrationAbortType:
			return wsReplyError{}
		}
		return nil
	}
}

// A move runs preflight, copy (again after a failed transfer), verify,
// switch and retire; while the files move the workspace takes no work and
// cannot be removed, and afterwards it runs on the target.
func TestWorkspaceMigrationMovesTheWorkspace(t *testing.T) {
	db := newTestStore(t)
	registerMigrationWorkspace(t, db)
	s := NewServer(db)
	shutDownAtCleanup(t, s)
	release := make(chan struct{})
	source := newFakeMigrationWorker(t, s, "dev_src", "src-box", sourceAnswers)
	target := newFakeMigrationWorker(t, s, "dev_dst", "dst-box", targetAnswers(release, true))

	requestForTest(t, s, http.MethodPost, "/api/workspaces/ws_move/migrations", `{"targetDeviceId":"dev_src","targetPath":"/x"}`, http.StatusBadRequest)
	requestForTest(t, s, http.MethodPost, "/api/workspaces/ws_move/migrations", `{"targetDeviceId":"dev_dst","targetPath":"relative"}`, http.StatusBadRequest)
	created := postJSONForTest(t, s, "/api/workspaces/ws_move/migrations", `{"targetDeviceId":"dev_dst","targetPath":"/dst/proj"}`, http.StatusCreated)
	if created["state"] != "preflight" || created["sourcePath"] != "/src/proj" || created["targetDeviceLabel"] != "dst-box" {
		t.Fatalf("created = %v", created)
	}
	requestForTest(t, s, http.MethodPost, "/api/workspaces/ws_move/migrations", `{"targetDeviceId":"dev_dst","targetPath":"/dst/other"}`, http.StatusConflict)
	// Renamed in Foundry while it moves: the move ends under that name, not
	// the host name the worker reports.
	if _, err := db.RenameDevice(context.Background(), "dev_dst", "Studio box"); err != nil {
		t.Fatal(err)
	}

	copying := driveMigration(t, s, db, func(r store.WorkspaceMigrationRecord) bool {
		return r.State == store.WorkspaceMigrationCopying && r.Attempts >= 2 && r.Bytes > 0
	})
	if len(copying.Warnings) != 1 || copying.TotalBytes != 10 {
		t.Fatalf("copying = %+v", copying)
	}
	workspace, err := db.GetWorkspace(context.Background(), "ws_move")
	if err != nil || workspace.Migration == nil || workspace.Migration.State != "copying" || workspace.Migration.Bytes != 10 {
		t.Fatalf("projection while copying = %+v %v", workspace.Migration, err)
	}
	refused := postJSONForTest(t, s, "/api/agent-sessions", `{"workspaceId":"ws_move","provider":"claude","prompt":"now"}`, http.StatusConflict)
	if message, _ := refused["error"].(string); !strings.Contains(message, "is moving to dst-box") {
		t.Fatalf("session while moving = %v", refused)
	}
	requestForTest(t, s, http.MethodDelete, "/api/workspaces/ws_move", "", http.StatusConflict)
	requestForTest(t, s, http.MethodPost, "/api/workspaces/ws_move/relink", `{"path":"/src/elsewhere"}`, http.StatusConflict)

	close(release)
	done := driveMigration(t, s, db, func(r store.WorkspaceMigrationRecord) bool { return store.WorkspaceMigrationEnded(r.State) })
	if done.State != store.WorkspaceMigrationComplete || done.CompletedAt == "" || done.ExecutionRoot == "" || done.TargetDeviceLabel != "Studio box" {
		t.Fatalf("done = %+v", done)
	}
	if !target.wasAsked(wsWorkspaceMigrationActivateType) || !source.wasAsked(wsWorkspaceMigrationRetireType) || target.wasAsked(wsWorkspaceMigrationAbortType) {
		t.Fatalf("source asked %v, target asked %v", source.asked, target.asked)
	}
	workspace, err = db.GetWorkspace(context.Background(), "ws_move")
	if err != nil || workspace.DeviceID != "dev_dst" || workspace.LocalPath != "/dst/proj" || workspace.Migration == nil || workspace.Migration.State != "complete" {
		t.Fatalf("workspace after the move = %+v %v", workspace, err)
	}
	current := requestForTest(t, s, http.MethodGet, "/api/workspaces/ws_move/migrations/current", "", http.StatusOK)
	if !strings.Contains(current.Body.String(), `"state":"complete"`) || strings.Contains(current.Body.String(), "manifestDigest") {
		t.Fatalf("current = %s", current.Body.String())
	}
	requestForTest(t, s, http.MethodPost, "/api/workspaces/ws_move/migrations/"+done.ID+"/cancel", "", http.StatusConflict)

	// Deleting the old copy keeps the changed file: a partial delete is recorded.
	purged := postJSONForTest(t, s, "/api/workspaces/ws_move/migrations/"+done.ID+"/purge-source", `{"confirm":true}`, http.StatusOK)
	migration, _ := purged["migration"].(map[string]any)
	purge, _ := migration["sourcePurge"].(map[string]any)
	if purged["done"] != false || purge["state"] != "none" || purge["keptCount"] != float64(1) || purge["lastAttemptAt"] == nil {
		t.Fatalf("partial purge = %v", purged)
	}
}

// Canceling while the files move removes the target's partial copy and
// frees the workspace on its device.
func TestWorkspaceMigrationCancelWhileCopying(t *testing.T) {
	db := newTestStore(t)
	registerMigrationWorkspace(t, db)
	s := NewServer(db)
	shutDownAtCleanup(t, s)
	newFakeMigrationWorker(t, s, "dev_src", "src-box", sourceAnswers)
	target := newFakeMigrationWorker(t, s, "dev_dst", "dst-box", targetAnswers(make(chan struct{}), false))
	created := postJSONForTest(t, s, "/api/workspaces/ws_move/migrations", `{"targetDeviceId":"dev_dst","targetPath":"/dst/proj"}`, http.StatusCreated)
	driveMigration(t, s, db, func(r store.WorkspaceMigrationRecord) bool {
		return r.State == store.WorkspaceMigrationCopying && r.Bytes > 0
	})
	canceled := postJSONForTest(t, s, "/api/workspaces/ws_move/migrations/"+created["id"].(string)+"/cancel", "", http.StatusOK)
	if canceled["cancelRequested"] != true {
		t.Fatalf("cancel = %v", canceled)
	}
	done := driveMigration(t, s, db, func(r store.WorkspaceMigrationRecord) bool { return store.WorkspaceMigrationEnded(r.State) })
	if done.State != store.WorkspaceMigrationCanceled || done.ReasonCode != migrationReasonCanceled || !target.wasAsked(wsWorkspaceMigrationAbortType) {
		t.Fatalf("done = %+v, target asked %v", done, target.asked)
	}
	workspace, _ := db.GetWorkspace(context.Background(), "ws_move")
	if workspace.DeviceID != "dev_src" || workspace.Migration != nil {
		t.Fatalf("workspace after cancel = %+v", workspace)
	}
	postJSONForTest(t, s, "/api/agent-sessions", `{"workspaceId":"ws_move","provider":"claude","prompt":"now"}`, http.StatusCreated)
}

// A preflight that cannot pass ends the move with what to do, before
// anything is frozen or copied.
func TestWorkspaceMigrationPreflightFailures(t *testing.T) {
	for name, tc := range map[string]struct {
		target func(*fakeMigrationWorker, wsEnvelope) any
		source func(*fakeMigrationWorker, wsEnvelope) any
		busy   bool
		code   string
	}{
		"target path taken": {
			target: func(_ *fakeMigrationWorker, envelope wsEnvelope) any {
				return wsWorkspaceMigrationCheckedPayload{OK: false, Reason: "exists and is not empty", FreeBytes: 1 << 40}
			},
			source: sourceAnswers, code: migrationReasonPathUnavailable,
		},
		"not enough space": {
			target: func(_ *fakeMigrationWorker, envelope wsEnvelope) any {
				return wsWorkspaceMigrationCheckedPayload{OK: true, FreeBytes: 1}
			},
			source: sourceAnswers, code: migrationReasonNoSpace,
		},
		"outdated source worker": {
			target: targetAnswers(nil, false),
			source: func(*fakeMigrationWorker, wsEnvelope) any { return nil },
			code:   migrationReasonWorkerOutdated,
		},
		"running session": {target: targetAnswers(nil, false), source: sourceAnswers, busy: true, code: migrationReasonBusy},
	} {
		t.Run(name, func(t *testing.T) {
			ask := migrationAskTimeout
			migrationAskTimeout = 200 * time.Millisecond
			t.Cleanup(func() { migrationAskTimeout = ask })
			db := newTestStore(t)
			registerMigrationWorkspace(t, db)
			s := NewServer(db)
			shutDownAtCleanup(t, s)
			newFakeMigrationWorker(t, s, "dev_src", "src-box", tc.source)
			target := newFakeMigrationWorker(t, s, "dev_dst", "dst-box", tc.target)
			if tc.busy {
				postJSONForTest(t, s, "/api/agent-sessions", `{"workspaceId":"ws_move","provider":"claude","prompt":"busy"}`, http.StatusCreated)
			}
			postJSONForTest(t, s, "/api/workspaces/ws_move/migrations", `{"targetDeviceId":"dev_dst","targetPath":"/dst/proj"}`, http.StatusCreated)
			done := driveMigration(t, s, db, func(r store.WorkspaceMigrationRecord) bool { return store.WorkspaceMigrationEnded(r.State) })
			if done.State != store.WorkspaceMigrationFailed || done.ReasonCode != tc.code || done.Reason == "" {
				t.Fatalf("done = %+v", done)
			}
			if tc.busy && (len(done.Blockers) != 1 || done.Blockers[0].Kind != "session") {
				t.Fatalf("blockers = %+v", done.Blockers)
			}
			if target.wasAsked(wsWorkspaceMigrationTransferType) {
				t.Fatal("a failed preflight started a transfer")
			}
			// The failed move stays on the workspace, not frozen.
			if workspace, _ := db.GetWorkspace(context.Background(), "ws_move"); workspace.DeviceID != "dev_src" ||
				workspace.Migration == nil || workspace.Migration.State != store.WorkspaceMigrationFailed || workspace.Migration.SourceDeviceLabel != "src-box" {
				t.Fatalf("workspace = %+v", workspace)
			}
			postJSONForTest(t, s, "/api/agent-sessions", `{"workspaceId":"ws_move","provider":"claude","prompt":"after"}`, http.StatusCreated)
		})
	}
}

// The data channel joins the source's and the target's socket, bytes flow
// both ways message by message, and only the device a stream was opened
// for, once, may dial it.
func TestWorkspaceMigrationStreamPairsTheWorkers(t *testing.T) {
	db := newEmptyTestStore(t)
	s := NewServerWithOptions(db, DefaultServerOptions())
	credentials := map[string]string{}
	connections := map[string]*daemonConnection{}
	for _, deviceID := range []string{"dev_src", "dev_dst"} {
		credentials[deviceID] = pairTestDevice(t, s, deviceID, deviceID+"-machine")
		c := newDaemonConnection(s.hub, nil)
		c.deviceID = deviceID
		c.actor = Actor{Kind: ActorDaemon, DeviceID: deviceID, DeviceCredentialHash: accounts.HashToken(credentials[deviceID])}
		s.hub.mu.Lock()
		s.hub.connections[deviceID] = c
		s.hub.mu.Unlock()
		connections[deviceID] = c
		t.Cleanup(func() { c.endLifetime(); close(c.done) })
	}
	live := serveForTest(t, s)
	pair, sourceStream, targetStream := s.hub.migrations.streams.open(context.Background(), "wsmove_test", connections["dev_src"], connections["dev_dst"])
	t.Cleanup(pair.close)
	dial := func(deviceID, streamID string) (*websocket.Conn, int) {
		headers := http.Header{deviceCredentialHeader: {credentials[deviceID]}}
		conn, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/migration-streams/"+streamID, headers)
		if err != nil {
			if response != nil {
				return nil, response.StatusCode
			}
			t.Fatalf("dial: %v", err)
		}
		t.Cleanup(func() { conn.Close() })
		return conn, http.StatusSwitchingProtocols
	}
	if _, status := dial("dev_dst", sourceStream); status != http.StatusNotFound {
		t.Fatalf("another device dialed the source's stream: %d", status)
	}
	targetConn, _ := dial("dev_dst", targetStream)
	if _, status := dial("dev_dst", targetStream); status != http.StatusNotFound {
		t.Fatalf("second claim: %d", status)
	}
	// The first to dial says HELLO before its partner is there: it waits,
	// it is not dropped.
	if err := targetConn.WriteMessage(websocket.BinaryMessage, []byte("HELLO target")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	sourceConn, _ := dial("dev_src", sourceStream)

	big := make([]byte, 1<<20)
	for i := range big {
		big[i] = byte(i)
	}
	if err := sourceConn.WriteMessage(websocket.BinaryMessage, big); err != nil {
		t.Fatal(err)
	}
	_ = sourceConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_ = targetConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if kind, data, err := sourceConn.ReadMessage(); err != nil || kind != websocket.BinaryMessage || string(data) != "HELLO target" {
		t.Fatalf("source read %d %q %v", kind, data, err)
	}
	if _, data, err := targetConn.ReadMessage(); err != nil || len(data) != len(big) || data[12345] != big[12345] {
		t.Fatalf("target read %d bytes, %v", len(data), err)
	}
	// Either side closing ends both.
	_ = sourceConn.Close()
	if _, _, err := targetConn.ReadMessage(); err == nil {
		t.Fatal("the target's socket stayed open")
	}
	select {
	case <-pair.done:
	case <-time.After(5 * time.Second):
		t.Fatal("the pair did not end")
	}
}
