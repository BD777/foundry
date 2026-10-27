package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

// piecesForTest splits an envelope as a worker does: its JSON text in parts
// of at most size bytes, never inside a character.
func piecesForTest(t *testing.T, envelope wsEnvelope, size int) []wsReplyChunkPayload {
	t.Helper()
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	pieces := []wsReplyChunkPayload{}
	for len(text) > 0 {
		end := min(size, len(text))
		for end < len(text) && (text[end]&0xC0) == 0x80 {
			end--
		}
		pieces = append(pieces, wsReplyChunkPayload{ID: envelope.ID, Seq: len(pieces), Data: text[:end]})
		text = text[end:]
	}
	pieces[len(pieces)-1].Last = true
	return pieces
}

// A worker on a slow uplink sends a large answer in pieces, with its own
// messages in between; the request gets the whole answer, and the
// registration told the worker it may.
func TestLargeReplyInPiecesAnswersItsRequest(t *testing.T) {
	db := newEmptyTestStore(t)
	server := NewServer(db)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":    map[string]any{"id": "dev_pieces", "label": "Slow uplink", "status": "connected"},
		"workspace": map[string]any{"id": "ws_pieces", "name": "Pieces", "localPath": "/tmp/pieces", "baseline": "main"},
	})
	var registered struct {
		Type    string `json:"type"`
		Payload struct {
			Features []string `json:"features"`
		} `json:"payload"`
	}
	if err := conn.ReadJSON(&registered); err != nil || registered.Type != wsRegisteredType {
		t.Fatalf("registration answer %+v, %v", registered, err)
	}
	if !slices.Contains(registered.Payload.Features, replyChunksFeature) {
		t.Fatalf("registered features = %v", registered.Payload.Features)
	}

	description := strings.Repeat("A skill described at length, über and 😀.", 8000)
	type result struct {
		skills []store.DeviceSkill
		err    error
	}
	done := make(chan result, 1)
	go func() {
		skills, _, err := server.hub.ScanDeviceSkills(context.Background(), "dev_pieces", []string{"~/.claude/skills"})
		done <- result{skills, err}
	}()
	var request wsEnvelope
	if err := conn.ReadJSON(&request); err != nil || request.Type != wsScanSkillsType {
		t.Fatalf("request %+v, %v", request, err)
	}
	payload, _ := json.Marshal(wsSkillsScannedPayload{Skills: []store.DeviceSkill{
		{Root: "~/.claude/skills", DirName: "long", Name: "long", Description: description},
	}})
	pieces := piecesForTest(t, wsEnvelope{ID: request.ID, Type: wsSkillsScannedType, Payload: payload}, 16<<10)
	if len(pieces) < 10 {
		t.Fatalf("%d pieces", len(pieces))
	}
	for index, piece := range pieces {
		writeWSIDForTest(t, conn, "", wsReplyChunkType, piece)
		if index == 1 {
			// A heartbeat between pieces is answered at once.
			writeWSIDForTest(t, conn, "beat_between", wsHeartbeatType, map[string]any{})
			var ack wsEnvelope
			if err := conn.ReadJSON(&ack); err != nil || ack.Type != wsAckType || ack.ID != "beat_between" {
				t.Fatalf("heartbeat between pieces answered %+v, %v", ack, err)
			}
		}
	}
	select {
	case got := <-done:
		if got.err != nil {
			t.Fatal(got.err)
		}
		if len(got.skills) != 1 || got.skills[0].Description != description {
			t.Fatalf("scan stored %d skills, or not the whole description", len(got.skills))
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the request never got its answer")
	}
}

// Pieces that cannot make one envelope are refused, and what arrived of it
// is let go.
func TestEnvelopePiecesRefuseWhatCannotAssemble(t *testing.T) {
	whole := wsEnvelope{ID: "rpc_1", Type: wsFileReadType, Payload: json.RawMessage(`{"content":"` + strings.Repeat("x", 100) + `"}`)}
	cases := map[string]func(t *testing.T) []wsReplyChunkPayload{
		"a later piece first": func(t *testing.T) []wsReplyChunkPayload {
			return piecesForTest(t, whole, 40)[1:]
		},
		"a piece twice": func(t *testing.T) []wsReplyChunkPayload {
			pieces := piecesForTest(t, whole, 40)
			return append([]wsReplyChunkPayload{pieces[0]}, pieces...)
		},
		"another envelope's id": func(t *testing.T) []wsReplyChunkPayload {
			pieces := piecesForTest(t, wsEnvelope{ID: "rpc_other", Type: wsFileReadType, Payload: whole.Payload}, 40)
			for i := range pieces {
				pieces[i].ID = "rpc_1"
			}
			return pieces
		},
		"a piece of pieces": func(t *testing.T) []wsReplyChunkPayload {
			inner, _ := json.Marshal(wsReplyChunkPayload{ID: "rpc_1", Data: "{}", Last: true})
			return piecesForTest(t, wsEnvelope{ID: "rpc_1", Type: wsReplyChunkType, Payload: inner}, 40)
		},
		"not an envelope": func(t *testing.T) []wsReplyChunkPayload {
			return []wsReplyChunkPayload{{ID: "rpc_1", Data: `{"id":"rpc_1",`}, {ID: "rpc_1", Seq: 1, Data: `"nope":1}`, Last: true}}
		},
	}
	for name, pieces := range cases {
		t.Run(name, func(t *testing.T) {
			var collected envelopePieces
			var failed error
			for _, piece := range pieces(t) {
				if _, complete, err := collected.add(piece); err != nil {
					failed = err
					break
				} else if complete {
					t.Fatal("assembled an envelope")
				}
			}
			if failed == nil {
				t.Fatal("no piece was refused")
			}
			if collected.bytes != 0 || len(collected.partial) != 0 {
				t.Fatalf("kept %d bytes of %d envelopes", collected.bytes, len(collected.partial))
			}
		})
	}

	var collected envelopePieces
	for _, piece := range piecesForTest(t, whole, 40) {
		got, complete, err := collected.add(piece)
		if err != nil {
			t.Fatal(err)
		}
		if complete && (got.ID != whole.ID || string(got.Payload) != string(whole.Payload)) {
			t.Fatalf("assembled %+v", got)
		}
	}
}

// A request whose answer arrives broken fails at once, not at its timeout.
func TestBrokenPiecesFailTheirRequestAtOnce(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	connection := newDaemonConnection(fixture.server.hub, nil)
	defer close(connection.done)
	waiter := connection.rpc.register("rpc_broken")
	payload, _ := json.Marshal(wsReplyChunkPayload{ID: "rpc_broken", Seq: 2, Data: "{}"})
	if _, _, err := connection.handleEnvelopePiece(wsEnvelope{Type: wsReplyChunkType, Payload: payload}); err == nil {
		t.Fatal("a piece out of order was taken")
	}
	select {
	case result := <-waiter:
		if result.err == nil {
			t.Fatal("the request got no error")
		}
	case <-time.After(time.Second):
		t.Fatal("the request still waits")
	}
}

// Credits are negotiated by the daemon so existing workers never mistake a
// piece acknowledgement for acknowledgement of the reliable whole envelope.
func TestBulkChunkCreditsAreNegotiated(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		server := NewServer(newEmptyTestStore(t))
		live := httptest.NewServer(server.Routes())
		conn := dialDaemonForTest(t, live)
		capabilities := []string{}
		if enabled {
			capabilities = append(capabilities, "reply_chunk_ack")
		}
		writeWSForTest(t, conn, "hello", map[string]any{"capabilities": capabilities, "device": map[string]any{"id": "dev_credit", "status": "connected"}, "workspace": map[string]any{"id": "ws_credit", "name": "W", "localPath": "/tmp/credit"}})
		readWSTypeForTest(t, conn, "registered")
		writeWSForTest(t, conn, "reply_chunk", map[string]any{"id": "bulk", "seq": 0, "data": "{\"id\":\"bulk\",\"payload\":"})
		writeWSIDForTest(t, conn, "beat_after_piece", "heartbeat", map[string]any{})
		var reply wsEnvelope
		if err := conn.ReadJSON(&reply); err != nil {
			t.Fatal(err)
		}
		if enabled {
			var payload struct {
				Seq int `json:"replyChunkSeq"`
			}
			_ = json.Unmarshal(reply.Payload, &payload)
			if reply.Type != wsAckType || reply.ID != "bulk" || payload.Seq != 0 {
				t.Fatalf("piece credit: %+v", reply)
			}
			if err := conn.ReadJSON(&reply); err != nil {
				t.Fatal(err)
			}
		}
		if reply.ID != "beat_after_piece" {
			t.Fatalf("old daemon got unexpected credit: %+v", reply)
		}
		conn.Close()
		live.Close()
	}
}
