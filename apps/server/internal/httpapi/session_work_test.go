package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessionwork"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestSessionWorkIncidentControlAndMCP(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "schedule inspection", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = backing.CompleteAgentSession(ctx, session.ID, "all stopped", "native_test"); err != nil {
		t.Fatal(err)
	}
	old := inspectionTimer
	if err = backing.AppendAgentSessionEvent(ctx, timerSnapshotEvent(session.ID, "old", []store.AgentScheduledTask{old})); err != nil {
		t.Fatal(err)
	}
	// This fixture represents a definition already adopted by an older worker.
	migrated := sessionwork.Timer(session, store.SessionKeptTimer{AgentScheduledTask: old})
	migrated.Native = nil
	migrated.Management = "managed"
	migrated.AllowedActions = []string{"pause", "resume", "stop", "remove", "run"}
	if _, err = backing.SaveSessionWork(ctx, migrated); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}
	path := "/api/agent-sessions/" + session.ID + "/work"
	status, raw := client.call(http.MethodGet, path, "", "")
	if status != 200 {
		t.Fatalf("inventory %d %s", status, raw)
	}
	var list store.SessionWorkList
	if err = json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 1 || list.Items[0].SourceID != "9b17c9d2" {
		t.Fatalf("legacy task was forgotten: %s", raw)
	}
	status, raw = client.call(http.MethodPost, path+"/operations", `{"action":"stop_all","idempotencyKey":"stop-once"}`, "")
	if status != 200 {
		t.Fatalf("stop %d %s", status, raw)
	}
	var op store.WorkOperation
	_ = json.Unmarshal(raw, &op)
	if op.State != "pending" {
		t.Fatalf("unconfirmed control was presented as stopped: %s", raw)
	}
	status, raw = client.call(http.MethodPost, "/api/daemon/sessions/"+session.ID+"/timer-fires", `{"timerId":"9b17c9d2","prompt":"inspect","dueAt":"2026-10-17T01:00:00Z","nativeSessionId":"native_test"}`, "")
	if status != http.StatusGone {
		t.Fatalf("late old worker fire escaped stop: %d %s", status, raw)
	}
	status, raw = client.call(http.MethodPost, path, `{"title":"late job","spec":{"schedule":"*/30 * * * *","prompt":"inspect"},"idempotencyKey":"late"}`, "")
	if status != 200 {
		t.Fatalf("create %d %s", status, raw)
	}
	var created store.SessionWork
	_ = json.Unmarshal(raw, &created)
	if created.DesiredState != "stopped" {
		t.Fatalf("new work escaped barrier: %s", raw)
	}
	status, raw = client.call(http.MethodPost, "/api/mcp", fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_session_work","arguments":{"sessionId":%q}}}`, session.ID), "")
	if status != 200 {
		t.Fatalf("mcp %d %s", status, raw)
	}
	var response struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err = json.Unmarshal(raw, &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Result.Content) == 0 {
		t.Fatalf("MCP has no work inventory: %s", raw)
	}
}

func TestSessionWorkSchedulerReadinessDoesNotConfuseRegistrationWithActivation(t *testing.T) {
	now := time.Date(2026, 10, 17, 6, 0, 0, 0, time.UTC)
	for _, tc := range []struct{ heartbeat, want string }{
		{"", "not_observed"},
		{now.Add(-3 * time.Second).Format(time.RFC3339Nano), "observed"},
		{now.Add(-2 * time.Minute).Format(time.RFC3339Nano), "stale"},
		{now.Add(time.Hour).Format(time.RFC3339Nano), "stale"},
	} {
		t.Run(tc.want+tc.heartbeat, func(t *testing.T) {
			list := store.SessionWorkList{Coverage: map[string]string{"observedAt": tc.heartbeat}, Items: []store.SessionWork{
				{Kind: "schedule", Management: "managed", DesiredState: "enabled", Revision: 2, Observation: store.WorkObservation{Status: "unknown", ConfirmedRevision: 0}},
				{Kind: "schedule", Management: "managed", DesiredState: "enabled", Revision: 1, Observation: store.WorkObservation{Status: "completed", ConfirmedRevision: 1}},
			}}
			projectWorkSchedulerReadiness(&list, now)
			if list.Coverage["scheduler"] != tc.want || (list.Items[0].Observation.Error == "") != (tc.want == "observed") {
				t.Fatalf("readiness not visible: %+v", list)
			}
			if list.Items[0].Observation.ConfirmedRevision != 0 || list.Items[0].Observation.Status != "unknown" || list.Items[1].Observation.Error != "" {
				t.Fatalf("readiness changed execution evidence/history: %+v", list.Items)
			}
		})
	}
}

func TestSessionWorkDispatchIsIdempotentAndStoppedGenerationCannotFire(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "inspect", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = backing.CompleteAgentSession(ctx, session.ID, "ready", "native_work"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	daemon := connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", "claude", []string{})
	client := queueClient{t: t, server: server, url: live.URL}
	path := "/api/agent-sessions/" + session.ID + "/work"
	status, raw := client.call(http.MethodPost, path, `{"title":"inspection","spec":{"schedule":"*/30 * * * *","prompt":"inspect fleet"},"idempotencyKey":"timer"}`, "")
	if status != 200 {
		t.Fatalf("create %d %s", status, raw)
	}
	var work store.SessionWork
	if err = json.Unmarshal(raw, &work); err != nil {
		t.Fatal(err)
	}
	if work.Observation.Error == "" || work.Observation.ConfirmedRevision != 0 {
		t.Fatalf("registration implied an active scheduler: %s", raw)
	}
	stored, err := backing.ListSessionWork(ctx, session.ID, "")
	if err != nil || len(stored.Items) != 1 || stored.Items[0].Observation.Error != "" {
		t.Fatalf("readiness diagnostic changed device evidence: %+v %v", stored, err)
	}
	if err = backing.SaveWorkCoverage(ctx, "dev_queue", map[string]string{"observedAt": time.Now().UTC().Format(time.RFC3339Nano)}); err != nil {
		t.Fatal(err)
	}
	status, raw = client.call(http.MethodGet, path, "", "")
	var ready store.SessionWorkList
	if err = json.Unmarshal(raw, &ready); err != nil || status != http.StatusOK || ready.Coverage["scheduler"] != "observed" || len(ready.Items) != 1 || ready.Items[0].Observation.Error != "" {
		t.Fatalf("fresh coordinator did not clear the diagnostic: %d %s %v", status, raw, err)
	}
	fire := fmt.Sprintf(`{"id":%q,"generation":%d,"scheduledAt":"2026-10-17T01:00:00Z"}`, work.ID, work.Generation)
	route := "/api/daemon/sessions/" + session.ID + "/work-fire"
	status, raw = client.call(http.MethodPost, route, fire, "")
	if status != 202 {
		t.Fatalf("fire %d %s", status, raw)
	}
	runs := daemon.waitForRuns(1)
	if runs[0].Input.TimerFire == nil || runs[0].Input.TimerFire.ID != work.ID {
		t.Fatalf("unattributed run %+v", runs[0].Input)
	}
	daemon.complete(runs[0], "done")
	waitFor(t, "scheduled turn settles", func() bool {
		current, e := backing.GetAgentSessionSummary(ctx, session.ID)
		return e == nil && current.Status == "completed"
	})
	finishedRuns, readErr := backing.ListWorkRuns(ctx, work.ID)
	if readErr != nil || len(finishedRuns) != 1 || finishedRuns[0].ScheduledAt == "" || finishedRuns[0].ExecutionSessionID != session.ID || finishedRuns[0].Status != "completed" {
		t.Fatalf("completion did not retain exact execution identity: %+v %v", finishedRuns, readErr)
	}
	status, raw = client.call(http.MethodPost, route, fire, "")
	if status != 200 {
		t.Fatalf("duplicate %d %s", status, raw)
	}
	if len(daemon.dispatched()) != 1 {
		t.Fatal("duplicate dispatch")
	}
	status, raw = client.call(http.MethodPost, path+"/operations", `{"action":"stop_all","idempotencyKey":"stop"}`, "")
	if status != 200 {
		t.Fatalf("stop %d %s", status, raw)
	}
	fire = fmt.Sprintf(`{"id":%q,"generation":%d,"scheduledAt":"2026-10-17T01:30:00Z"}`, work.ID, work.Generation)
	status, raw = client.call(http.MethodPost, route, fire, "")
	if status != 409 {
		t.Fatalf("stopped fire %d %s", status, raw)
	}
	if len(daemon.dispatched()) != 1 {
		t.Fatal("stopped generation dispatched")
	}
	status, _ = client.call(http.MethodPost, path, `{"title":"bad","spec":{"schedule":"61 * * * *","prompt":"bad"},"idempotencyKey":"invalid"}`, "")
	if status != 400 {
		t.Fatalf("invalid cron accepted %d", status)
	}
}

func TestSessionWorkExplicitNewSessionRunAfterStopIsNotImportedAsStoppedChild(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	parent, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "owner", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = backing.CompleteAgentSession(ctx, parent.ID, "ready", "native_owner"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	daemon := connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", "claude", []string{})
	client := queueClient{t: t, server: server, url: live.URL}
	path := "/api/agent-sessions/" + parent.ID + "/work"
	status, raw := client.call(http.MethodPost, path, `{"title":"independent inspection","spec":{"schedule":"0 9 * * *","target":"new_session","prompt":"inspect"},"idempotencyKey":"independent"}`, "")
	if status != 200 {
		t.Fatalf("create %d %s", status, raw)
	}
	var item store.SessionWork
	_ = json.Unmarshal(raw, &item)
	status, raw = client.call(http.MethodPost, path+"/operations", `{"action":"stop_all","idempotencyKey":"stop"}`, "")
	if status != 200 {
		t.Fatalf("stop %d %s", status, raw)
	}
	status, raw = client.call(http.MethodPost, path+"/operations", fmt.Sprintf(`{"id":%q,"action":"resume","expectedRevision":2,"idempotencyKey":"explicit-resume"}`, item.ID), "")
	if status != 200 {
		t.Fatalf("resume %d %s", status, raw)
	}
	status, raw = client.call(http.MethodPost, "/api/daemon/sessions/"+parent.ID+"/work-fire", fmt.Sprintf(`{"id":%q,"generation":2,"scheduledAt":"2026-10-17T01:00:00Z"}`, item.ID), "")
	if status != 202 {
		t.Fatalf("fire %d %s", status, raw)
	}
	runs := daemon.waitForRuns(1)
	if runs[0].ID == parent.ID {
		t.Fatal("new-session target continued owner")
	}
	status, raw = client.call(http.MethodGet, path, "", "")
	if status != 200 {
		t.Fatalf("list %d %s", status, raw)
	}
	var list store.SessionWorkList
	_ = json.Unmarshal(raw, &list)
	for _, work := range list.Items {
		if work.Kind == "agent" && work.SourceID == runs[0].ID {
			t.Fatal("authorized schedule run was imported as an independently stopped child")
		}
	}
	daemon.complete(runs[0], "done")
}

func TestSessionWorkBarrierRefusesLateChildDispatch(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	parent, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "owner", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = backing.ControlSessionWork(ctx, parent.ID, parent.ID, store.WorkControlInput{Action: "stop_all", IdempotencyKey: "stop"}); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	_, err = server.startAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "late child", ParentSessionID: parent.ID})
	if err == nil || !strings.Contains(err.Error(), "automatic work is stopped") {
		t.Fatalf("late child not blocked: %v", err)
	}
}

func TestSessionWorkDeviceRecoversAnEmptyStoppedConversation(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	parent, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "owner", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	op, err := backing.ControlSessionWork(ctx, parent.ID, parent.ID, store.WorkControlInput{Action: "stop_all", IdempotencyKey: "stop"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}
	status, raw := client.call(http.MethodGet, "/api/daemon/session-work", "", "")
	if status != http.StatusForbidden {
		t.Fatalf("unbound test daemon read device inventory: %d %s", status, raw)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/daemon/session-work", nil).WithContext(actorInContext(ctx, Actor{Kind: ActorDaemon, DeviceID: parent.DeviceID}))
	response := httptest.NewRecorder()
	server.handleDeviceWork(response, request)
	raw = response.Body.Bytes()
	if response.Code != http.StatusOK {
		t.Fatalf("bound device inventory %d %s", response.Code, raw)
	}
	var list store.SessionWorkList
	if err = json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	if list.SweepRevision < op.Sequence || len(list.Scopes) != 1 || list.Scopes[0].ID != parent.ID || list.Scopes[0].WorkspacePath == "" {
		t.Fatalf("empty stopped conversation was not recoverable: %s", raw)
	}
}

func TestSessionWorkBulkStopDoesNotCancelTheConversation(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "continue the conversation", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}
	status, raw := client.call(http.MethodPost, "/api/agent-sessions/"+session.ID+"/work/operations", `{"action":"stop_all","idempotencyKey":"tasks-only"}`, "")
	if status != 200 {
		t.Fatalf("stop %d %s", status, raw)
	}
	current, err := backing.GetAgentSessionSummary(ctx, session.ID)
	if err != nil || current.Status != session.Status {
		t.Fatalf("task controls canceled the chat: before=%s after=%+v %v", session.Status, current, err)
	}
}

func TestSessionWorkCreationCannotSmuggleManualRunThroughBarrierOrReuseKey(t *testing.T) {
	ctx := context.Background()
	backing := newEmptyTestStore(t)
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "test"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	input := createWorkInput{Title: "timer", IdempotencyKey: "same", Kind: "schedule", Spec: store.WorkSpec{At: "2026-10-17T01:00:00Z", Prompt: "once"}}
	first, err := server.createWork(ctx, session, input)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := server.createWork(ctx, session, input); err != nil || again.ID != first.ID {
		t.Fatalf("retry not idempotent: %+v %v", again, err)
	}
	input.Spec.Prompt = "different"
	if _, err := server.createWork(ctx, session, input); err == nil {
		t.Fatal("key reuse silently kept a different definition")
	}
	input.IdempotencyKey = "smuggle"
	input.Spec.ManualRunAt = input.Spec.At
	if _, err := server.createWork(ctx, session, input); err == nil {
		t.Fatal("client supplied server-owned manual intent")
	}
}

func TestSessionWorkClaimRecoveryUsesRecordedInputInsteadOfSessionTimestamp(t *testing.T) {
	for _, accepted := range []bool{false, true} {
		t.Run(fmt.Sprint(accepted), func(t *testing.T) {
			ctx := context.Background()
			backing := newEmptyTestStore(t)
			registerQueueDevice(t, backing, "claude")
			session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "first"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = backing.CompleteAgentSession(ctx, session.ID, "done", "native"); err != nil {
				t.Fatal(err)
			}
			server := NewServer(backing)
			item, err := server.createWork(ctx, session, createWorkInput{Title: "timer", IdempotencyKey: "recover", Kind: "schedule", Spec: store.WorkSpec{Schedule: "* * * * *", Prompt: "scheduled"}})
			if err != nil {
				t.Fatal(err)
			}
			run, claimed, err := backing.ClaimWorkRun(ctx, item.ID, 1, "2026-10-17T01:00:00Z")
			if err != nil || !claimed {
				t.Fatalf("claim %v %v", claimed, err)
			}
			if accepted {
				_, err = backing.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: "scheduled", InputID: scheduledWorkInputID(item, run)})
				if err != nil {
					t.Fatal(err)
				}
			}
			list, _ := backing.ListSessionWork(ctx, session.ID, "")
			recovered, err := NewServer(backing).settleScheduledWork(ctx, list.Items[0], nil)
			if err != nil {
				t.Fatal(err)
			}
			want := "failed"
			if accepted {
				want = "running"
			}
			if recovered.Observation.Status != want {
				t.Fatalf("crash recovery guessed dispatch: %+v", recovered.Observation)
			}
			if !accepted && recovered.Observation.Error == "" {
				t.Fatal("missing delivery lost its reason")
			}
		})
	}
}

func TestSessionWorkResidentSupervisorActuallyWakesAnIdleSession(t *testing.T) {
	module, err := filepath.Abs("../../../../packages/worker/dist/session-work/supervisor.js")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(module); err != nil {
		t.Skip("build the Worker first for the cross-runtime acceptance check")
	}
	if _, err = exec.LookPath("node"); err != nil {
		t.Skip("Node is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	backing := newEmptyTestStore(t)
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "idle owner"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = backing.CompleteAgentSession(ctx, session.ID, "done", "native"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	daemon := connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", "claude", []string{})
	item, err := server.createWork(ctx, session, createWorkInput{Title: "acceptance wake", IdempotencyKey: "automatic", Kind: "schedule", Spec: store.WorkSpec{At: time.Now().Add(300 * time.Millisecond).UTC().Format(time.RFC3339Nano), Prompt: "isolated automatic wake"}})
	if err != nil {
		t.Fatal(err)
	}
	bound := http.NewServeMux()
	bind := func(handler http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			handler(w, r.WithContext(actorInContext(r.Context(), Actor{Kind: ActorDaemon, DeviceID: session.DeviceID})))
		}
	}
	bound.HandleFunc("/api/daemon/session-work", bind(server.handleDeviceWork))
	bound.HandleFunc("/api/daemon/sessions/{id}/work-fire", bind(server.handleWorkFire))
	api := httptest.NewServer(bound)
	defer api.Close()
	root := t.TempDir()
	script := `import {readFileSync} from 'node:fs';const {WorkSupervisor}=await import(process.argv[1]);const supervisor=new WorkSupervisor(process.argv[3]);supervisor.hosts.scan=()=>({entries:[],errors:[]});await supervisor.start(process.argv[2]);supervisor.stop();for(let n=0;n<100;n++){await new Promise(r=>setTimeout(r,30));await supervisor.tick();const item=JSON.parse(readFileSync(process.argv[3]+'/inventory.json','utf8')).items.find(x=>x.id===process.argv[4]);if(item?.observation.status==='completed'&&item.observation.confirmedRevision===item.revision){console.log(JSON.stringify(item.observation));process.exit(0)}}throw Error('scheduled execution did not settle');`
	cmd := exec.CommandContext(ctx, "node", "--input-type=module", "-e", script, "file://"+filepath.ToSlash(module), api.URL, root, item.ID)
	cmd.Env = append(os.Environ(), "FOUNDRY_STATE_ROOT="+filepath.Join(root, "state"))
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})
	runs := daemon.waitForRuns(1)
	if runs[0].Input.Prompt != "isolated automatic wake" || runs[0].Input.TimerFire == nil || runs[0].Input.TimerFire.ID != item.ID {
		t.Fatalf("automatic wake lost input attribution: %+v", runs[0].Input)
	}
	daemon.complete(runs[0], "automatic wake completed")
	if err = cmd.Wait(); err != nil {
		t.Fatalf("resident supervisor failed: %v\n%s", err, output.String())
	}
	if len(daemon.dispatched()) != 1 {
		t.Fatal("automatic wake duplicated its input")
	}
	var observed store.WorkObservation
	if err = json.Unmarshal(bytes.TrimSpace(output.Bytes()), &observed); err != nil || observed.Status != "completed" || observed.RunID == "" {
		t.Fatalf("unverified wake: %s %v", output.String(), err)
	}
}

func TestSessionWorkRejectedFutureAckCannotPersistAsConfirmation(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "test", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	item := store.SessionWork{ID: "work_unused", SessionID: session.ID, ThreadID: session.ID, Kind: "process", Source: "process", SourceID: "999999:boot:1", Management: "managed", DesiredState: "enabled", AllowedActions: []string{"stop"}, Observation: store.WorkObservation{Status: "running", ProcessRole: "background", ConfirmedRevision: 99}}
	item.ID = sessionwork.ID(session.ID, item.Source, item.SourceID)
	body, _ := json.Marshal(map[string]any{"items": []store.SessionWork{item}})
	request := httptest.NewRequest(http.MethodPost, "/api/daemon/session-work", bytes.NewReader(body)).WithContext(actorInContext(ctx, Actor{Kind: ActorDaemon, DeviceID: session.DeviceID}))
	response := httptest.NewRecorder()
	server.handleDeviceWork(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("future ack=%d %s", response.Code, response.Body.String())
	}
	list, err := backing.ListSessionWork(ctx, session.ID, "")
	if err != nil || len(list.Items) != 1 || list.Items[0].Observation.ConfirmedRevision != 0 {
		t.Fatalf("rejected ACK persisted as confirmation: %+v %v", list, err)
	}
}

func TestSessionWorkShowsDirectChildrenAndLeavesTheirWorkAlone(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "codex")
	root, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "codex", Prompt: "DEV022 root", Title: "root"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "codex", Prompt: "child", Title: "direct child", ParentSessionID: root.ID})
	if err != nil {
		t.Fatal(err)
	}
	grandchild, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "codex", Prompt: "grandchild", ParentSessionID: child.ID})
	if err != nil {
		t.Fatal(err)
	}
	service := sessionwork.Base(child, "process", "foundry", "child-service", "child service")
	service.Observation.Status = "running"
	if _, err = backing.SaveSessionWork(ctx, service); err != nil {
		t.Fatal(err)
	}
	native := sessionwork.Base(root, "agent", "codex", "native-child", "native agent")
	if _, err = backing.SaveSessionWork(ctx, native); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}
	path := "/api/agent-sessions/" + root.ID + "/work"
	status, raw := client.call(http.MethodGet, path, "", "")
	if status != 200 {
		t.Fatalf("inventory %d %s", status, raw)
	}
	var list store.SessionWorkList
	if err = json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	seenChild, seenNative := false, false
	for _, w := range list.Items {
		if w.SourceID == child.ID {
			seenChild = true
		}
		if w.SourceID == grandchild.ID || w.ID == service.ID {
			t.Fatalf("descendant flattened: %+v", w)
		}
		if w.ID == native.ID {
			seenNative = true
			if len(w.AllowedActions) != 0 || w.Management != "observed" {
				t.Fatalf("native agent exposed controls: %+v", w)
			}
		}
	}
	if !seenChild || !seenNative {
		t.Fatalf("missing direct work: %s", raw)
	}
	status, raw = client.call(http.MethodPost, path+"/operations", `{"action":"stop_all","idempotencyKey":"direct-only"}`, "")
	if status != 200 {
		t.Fatalf("stop %d %s", status, raw)
	}
	nested, err := backing.ListSessionWork(ctx, child.ID, "")
	if err != nil || nested.Barrier {
		t.Fatalf("parent barrier reached child: %+v %v", nested, err)
	}
	for _, w := range nested.Items {
		if w.ID == service.ID && w.DesiredState != "enabled" {
			t.Fatal("parent stopped hidden service")
		}
	}
	current, _ := backing.ListSessionWork(ctx, root.ID, "")
	for _, w := range current.Items {
		if w.ID == native.ID && w.DesiredState != "enabled" {
			t.Fatal("bulk stop changed read-only native agent")
		}
	}
}

func TestSessionWorkSharedServiceAssociationAuthorizationAndScope(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "codex")
	owner, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "codex", Prompt: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	consumer, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "codex", Prompt: "consumer"})
	if err != nil {
		t.Fatal(err)
	}
	service := sessionwork.Base(owner, "process", "foundry", "durable", "one service")
	service, err = backing.SaveSessionWork(ctx, service)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}
	path := "/api/agent-sessions/" + owner.ID + "/work/operations"
	body := func(target, key string) string {
		return fmt.Sprintf(`{"id":%q,"action":"link","relatedSessionId":%q,"expectedRevision":1,"idempotencyKey":%q}`, service.ID, target, key)
	}
	status, _ := client.call(http.MethodPost, path, body("not-readable", "invalid"), "")
	if status != http.StatusForbidden {
		t.Fatalf("association with inaccessible session: %d", status)
	}
	status, raw := client.call(http.MethodPost, path, body(consumer.ID, "associate"), "")
	if status != 200 {
		t.Fatalf("link %d %s", status, raw)
	}
	status, raw = client.call(http.MethodGet, "/api/agent-sessions/"+consumer.ID+"/work", "", "")
	if status != 200 {
		t.Fatal(status)
	}
	var list store.SessionWorkList
	if err = json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 1 || list.Items[0].ID != service.ID || list.Items[0].SharedSessionCount != 1 || list.Items[0].ReferenceRevision != 1 {
		t.Fatalf("reference identity lost %s", raw)
	}
	stale := fmt.Sprintf(`{"id":%q,"action":"stop","expectedRevision":1,"idempotencyKey":"stale-scope"}`, service.ID)
	status, raw = client.call(http.MethodPost, path, stale, "")
	if status != http.StatusConflict {
		t.Fatalf("outdated global impact accepted %d %s", status, raw)
	}
	fresh := fmt.Sprintf(`{"id":%q,"action":"stop","expectedRevision":1,"expectedReferenceRevision":1,"idempotencyKey":"global-stop"}`, service.ID)
	status, raw = client.call(http.MethodPost, path, fresh, "")
	if status != 200 {
		t.Fatalf("explicit shared stop %d %s", status, raw)
	}
	after, _ := backing.ListSessionWork(ctx, consumer.ID, "")
	if after.Items[0].DesiredState != "stopped" {
		t.Fatal("global control did not reach same service")
	}
}

func TestWorkspaceServicesRemainManageableWithoutLinkedOrActiveSessions(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "codex")
	owner, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "codex", Prompt: "service creator"})
	if err != nil {
		t.Fatal(err)
	}
	service := sessionwork.Base(owner, "process", "foundry", "workspace-service", "durable workspace service")
	service.AllowedActions = []string{"stop", "remove"}
	service, err = backing.SaveSessionWork(ctx, service)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = backing.CompleteAgentSession(ctx, owner.ID, "finished", "native"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}
	status, raw := client.call(http.MethodGet, "/api/workspaces/ws_queue/services", "", "")
	if status != 200 {
		t.Fatalf("list %d %s", status, raw)
	}
	var services []store.SessionWork
	if err = json.Unmarshal(raw, &services); err != nil {
		t.Fatal(err)
	}
	if len(services) != 1 || services[0].ID != service.ID || len(services[0].RelatedSessionIDs) != 0 {
		t.Fatalf("service lost after session end %s", raw)
	}
	status, raw = client.call(http.MethodPost, "/api/workspaces/ws_queue/services/"+service.ID+"/operations", `{"action":"stop","expectedRevision":1,"idempotencyKey":"workspace-stop"}`, "")
	if status != 200 {
		t.Fatalf("workspace control %d %s", status, raw)
	}
	if err = backing.ObserveSessionWork(ctx, service.ID, store.WorkObservation{Status: "stopped", At: time.Now().UTC().Format(time.RFC3339Nano), ConfirmedRevision: 2}); err != nil {
		t.Fatal(err)
	}
	archive := `{"action":"remove","expectedRevision":2,"idempotencyKey":"archive-service"}`
	status, first := client.call(http.MethodPost, "/api/workspaces/ws_queue/services/"+service.ID+"/operations", archive, "")
	if status != 200 {
		t.Fatalf("archive %d %s", status, first)
	}
	status, retry := client.call(http.MethodPost, "/api/workspaces/ws_queue/services/"+service.ID+"/operations", archive, "")
	if status != 200 || !bytes.Equal(first, retry) {
		t.Fatalf("archive retry lost durable receipt: %d %s", status, retry)
	}

	if err = backing.RegisterDaemon(ctx, store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_other", Label: "Other", Status: "connected"}, Workspace: store.WorkspaceProjection{ID: "ws_other", Name: "Other", LocalPath: t.TempDir()}, Agents: []store.AgentProjection{{ID: "agent_other", WorkspaceID: "ws_other", DeviceID: "dev_other", Provider: "codex", Status: "healthy"}}}); err != nil {
		t.Fatal(err)
	}
	other, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_other", AgentID: "agent_other", Provider: "codex", Prompt: "foreign"})
	if err != nil {
		t.Fatal(err)
	}
	{
		status, _ = client.call(http.MethodPost, "/api/workspaces/ws_queue/services/"+service.ID+"/operations", fmt.Sprintf(`{"action":"link","relatedSessionId":%q,"expectedRevision":2,"idempotencyKey":"foreign-link"}`, other.ID), "")
		if status != http.StatusForbidden {
			t.Fatalf("cross-workspace service link allowed: %d", status)
		}
	}
}

func TestSessionWorkNativeRunMetadataRoundTrip(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "native timer"})
	if err != nil {
		t.Fatal(err)
	}
	session, err = backing.CompleteAgentSession(ctx, session.ID, "waiting", "native")
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}
	item := sessionwork.Base(session, "schedule", "claude", "native-timer", "native schedule")
	item.Management = "observed"
	item.AllowedActions = []string{}
	item.Spec.Recurring = true
	item.Native = &store.NativeWorkInfo{Runtime: "claude", Version: "2.1.295", SessionID: "native", TaskID: "native-timer", LastRun: &store.NativeWorkRun{ID: "native-timer@first", StartedAt: "2026-10-19T00:00:00Z", Status: "running"}}
	item.Observation = store.WorkObservation{Status: "running", At: time.Now().UTC().Format(time.RFC3339Nano), ConfirmedRevision: 1}
	raw, _ := json.Marshal(map[string]any{"items": []store.SessionWork{item}})
	status, body := client.call(http.MethodPost, "/api/daemon/session-work", string(raw), "")
	if status != 200 {
		t.Fatalf("observe %d %s", status, body)
	}
	status, body = client.call(http.MethodGet, "/api/agent-sessions/"+session.ID+"/work", "", "")
	if status != 200 {
		t.Fatal(status)
	}
	var list store.SessionWorkList
	if err = json.Unmarshal(body, &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 1 || list.Items[0].Native.LastRun.ID != "native-timer@first" || list.Items[0].Observation.Status != "running" || list.Items[0].Management != "observed" {
		t.Fatalf("native definition/execution collapsed: %s", body)
	}
	if _, claimed, err := backing.ClaimWorkRun(ctx, item.ID, 1, "2026-10-19T01:00:00Z"); err == nil || claimed {
		t.Fatalf("native run acquired second executor %v %v", claimed, err)
	}
}

// DEV-085: a device that names its cursor reads only what changed after it;
// polling a running child or a recorded run changes nothing.
func TestSessionWorkDeviceReadsOnlyChangesAfterItsCursor(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "codex")
	root, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "codex", Prompt: "root", Title: "root"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "codex", Prompt: "child", Title: "child", ParentSessionID: root.ID})
	if err != nil {
		t.Fatal(err)
	}
	var old []string
	for i := range 3 {
		item := sessionwork.Base(root, "process", "process", fmt.Sprintf("%d:boot:1", 1000+i), "finished command")
		item.Observation = store.WorkObservation{Status: "completed", ProcessRole: "background", At: "2026-10-29T10:00:00Z", EndedAt: "2026-10-29T10:00:00Z"}
		if _, err = backing.SaveSessionWork(ctx, item); err != nil {
			t.Fatal(err)
		}
		old = append(old, item.ID)
	}
	server := NewServer(backing)
	read := func(method, cursor string, body any) store.SessionWorkList {
		t.Helper()
		target := "/api/daemon/session-work"
		if cursor != "-" {
			target += "?cursor=" + url.QueryEscape(cursor)
		}
		var payload io.Reader
		if body != nil {
			raw, _ := json.Marshal(body)
			payload = bytes.NewReader(raw)
		}
		request := httptest.NewRequest(method, target, payload).WithContext(actorInContext(ctx, Actor{Kind: ActorDaemon, DeviceID: root.DeviceID}))
		request.Header.Set("X-Foundry-Native-Work", "1")
		response := httptest.NewRecorder()
		server.handleDeviceWork(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s %s: %d %s", method, target, response.Code, response.Body.String())
		}
		var list store.SessionWorkList
		if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
			t.Fatal(err)
		}
		return list
	}
	ids := func(list store.SessionWorkList) []string {
		out := []string{}
		for _, item := range list.Items {
			out = append(out, item.ID)
		}
		slices.Sort(out)
		return out
	}

	running := sessionwork.Base(root, "agent", "foundry", child.ID, child.Title)
	running.Observation.Status = "running"
	if _, err = backing.SaveSessionWork(ctx, running); err != nil {
		t.Fatal(err)
	}
	full := read(http.MethodGet, "", nil)
	if len(full.Items) != 4 || full.Cursor == "" || full.Items[0].Spec.Cwd == "" {
		t.Fatalf("first read: %+v", full)
	}
	for range 2 {
		if idle := read(http.MethodGet, full.Cursor, nil); len(idle.Items) != 0 || idle.Cursor != full.Cursor {
			t.Fatalf("polling a running child changed its work: %+v", idle)
		}
	}
	if _, err = backing.CompleteAgentSession(ctx, child.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	ended := read(http.MethodGet, full.Cursor, nil)
	if len(ended.Items) != 1 || ended.Items[0].SourceID != child.ID || ended.Items[0].Observation.Status != "completed" {
		t.Fatalf("child completion: %+v", ended)
	}
	report := full.Items[0]
	for _, item := range full.Items {
		if item.ID == old[0] {
			report = item
		}
	}
	report.Observation.Status, report.Observation.At = "stopped", "2026-10-29T11:00:00Z"
	posted := read(http.MethodPost, ended.Cursor, map[string]any{"items": []store.SessionWork{report}})
	if !slices.Equal(ids(posted), []string{old[0]}) || posted.Items[0].Observation.Status != "stopped" {
		t.Fatalf("report answer: %+v", posted)
	}
	// A device without cursors still reads everything.
	legacy := read(http.MethodGet, "-", nil)
	if len(legacy.Items) != 4 || legacy.Cursor != "" {
		t.Fatalf("legacy read: %+v", legacy)
	}
}

// DEV-085: a paused one-shot schedule whose run completed is "stopped" on
// its device; settling the recorded run again must not flip it back to
// "completed" on every device poll.
func TestSettledRunLeavesTheDevicesLaterObservation(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "once", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	item := sessionwork.Base(session, "schedule", "foundry", "once", "one-shot")
	item.Spec = store.WorkSpec{At: "2026-10-26T09:59:00Z", TimeZone: "UTC", Prompt: "once"}
	saved, err := backing.SaveSessionWork(ctx, item)
	if err != nil {
		t.Fatal(err)
	}
	run, _, err := backing.ClaimWorkRun(ctx, saved.ID, saved.Generation, "2026-10-26T09:59:00Z")
	if err != nil {
		t.Fatal(err)
	}
	run.ExecutionSessionID, run.Status, run.EndedAt = session.ID, "completed", "2026-10-26T10:01:03Z"
	if err = backing.FinishWorkRun(ctx, run); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	current := func() store.SessionWork {
		list, _ := backing.ListSessionWork(ctx, session.ID, "")
		for _, w := range list.Items {
			if w.ID == saved.ID {
				return w
			}
		}
		t.Fatal("work missing")
		return store.SessionWork{}
	}
	if err = backing.ObserveSessionWork(ctx, saved.ID, store.WorkObservation{Status: "running", At: "2026-10-26T09:59:05Z", RunID: run.ID, StartedAt: run.StartedAt, ConfirmedRevision: saved.Revision}); err != nil {
		t.Fatal(err)
	}
	if _, err = server.settleScheduledWork(ctx, current(), nil); err != nil || current().Observation.Status != "completed" {
		t.Fatalf("first settle: %+v %v", current().Observation, err)
	}
	stopped := current().Observation
	stopped.Status, stopped.At = "stopped", time.Now().UTC().Format(time.RFC3339Nano)
	if err = backing.ObserveSessionWork(ctx, saved.ID, stopped); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, err = server.settleScheduledWork(ctx, current(), nil); err != nil {
			t.Fatal(err)
		}
	}
	if got := current().Observation; got.Status != "stopped" || got.At != stopped.At {
		t.Fatalf("settling a recorded run overwrote the device's observation: %+v", got)
	}
}
