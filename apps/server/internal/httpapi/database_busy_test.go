package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessionwork"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type sqliteCodeError struct{ code int }

func (e sqliteCodeError) Error() string { return fmt.Sprintf("sqlite error %d", e.code) }
func (e sqliteCodeError) Code() int     { return e.code }

func TestDatabaseBusyAnswersRetryable(t *testing.T) {
	for name, write := range map[string]func(http.ResponseWriter){
		"busy":          func(w http.ResponseWriter) { writeResult(w, nil, fmt.Errorf("save: %w", sqliteCodeError{5})) },
		"busy snapshot": func(w http.ResponseWriter) { writeResult(w, nil, sqliteCodeError{5 | 2<<8}) },
		"locked":        func(w http.ResponseWriter) { writeResult(w, nil, sqliteCodeError{6}) },
		"refusal around busy": func(w http.ResponseWriter) {
			writeResult(w, nil, &statusError{http.StatusConflict, sqliteCodeError{5}})
		},
		"message only": func(w http.ResponseWriter) {
			writeError(w, http.StatusInternalServerError, "database is locked (5) (SQLITE_BUSY)")
		},
	} {
		recorder := httptest.NewRecorder()
		write(recorder)
		if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get("Retry-After") == "" ||
			!bytes.Contains(recorder.Body.Bytes(), []byte(`"code":"database_busy"`)) {
			t.Errorf("%s: %d %v %s", name, recorder.Code, recorder.Header(), recorder.Body)
		}
	}
	recorder := httptest.NewRecorder()
	writeResult(recorder, nil, errors.New("disk I/O error"))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("an ordinary failure = %d", recorder.Code)
	}
	if store.IsBusy(sqliteCodeError{1}) {
		t.Fatal("SQLITE_ERROR is not busy")
	}
}

// DEV-059: another process (an admin CLI) holding the write lock answered
// the Timers panel's read and the device's work report with an immediate
// 500 "database is locked". The read now needs no write lock, and a write
// waits for the lock instead of failing.
func TestSessionWorkSurvivesAnotherProcessWriteLock(t *testing.T) {
	dbPath := t.TempDir() + "/foundry.db"
	backing, err := sqlitestore.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer backing.Close()
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "schedule inspection", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	if err = backing.AppendAgentSessionEvent(ctx, timerSnapshotEvent(session.ID, "snapshot", []store.AgentScheduledTask{inspectionTimer})); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}
	path := "/api/agent-sessions/" + session.ID + "/work"
	if status, raw := client.call(http.MethodGet, path, "", ""); status != http.StatusOK {
		t.Fatalf("first read (imports the timer) %d %s", status, raw)
	}

	other, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	conn, err := other.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	const hold = 1500 * time.Millisecond
	released := make(chan struct{})
	go func() {
		defer close(released)
		time.Sleep(hold)
		_, _ = conn.ExecContext(ctx, "COMMIT")
		_ = conn.Close()
	}()
	defer func() { <-released }()

	started := time.Now()
	if status, raw := client.call(http.MethodGet, path, "", ""); status != http.StatusOK {
		t.Fatalf("read while another process holds the write lock: %d %s", status, raw)
	}
	if elapsed := time.Since(started); elapsed >= hold {
		t.Fatalf("read waited %s for the write lock", elapsed)
	}

	timer := sessionwork.Timer(session, store.SessionKeptTimer{AgentScheduledTask: inspectionTimer})
	body := fmt.Sprintf(`{"items":[],"coverage":{"hostSchedules":"observed","processes":"observed","observedAt":%q}}`, time.Now().UTC().Format(time.RFC3339Nano))
	request := httptest.NewRequest(http.MethodPost, "/api/daemon/session-work", bytes.NewReader([]byte(body))).
		WithContext(actorInContext(ctx, Actor{Kind: ActorDaemon, DeviceID: timer.DeviceID}))
	request.Header.Set("X-Foundry-Native-Work", "1")
	recorder := httptest.NewRecorder()
	server.handleDeviceWork(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("device report while locked: %d %s", recorder.Code, recorder.Body)
	}
	select {
	case <-released:
	default:
		t.Fatal("the device report's write did not wait for the lock")
	}
}
