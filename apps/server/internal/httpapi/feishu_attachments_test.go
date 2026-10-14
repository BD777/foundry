package httpapi

import (
	"context"
	"encoding/base64"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	storepkg "github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Files a Feishu message brings are stored on the workspace's device as a
// person's upload is, named and typed the same way, within its limit.
func TestFeishuFilesGoThroughTheWorkspaceDevice(t *testing.T) {
	server := NewServer(newEmptyTestStore(t))
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()
	const attachments = "/nonexistent-on-server/remote-ws/.foundry/attachments"
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(testServer.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":    map[string]any{"id": "dev_remote", "label": "Remote", "status": "connected", "lastSeenLabel": "online"},
		"workspace": map[string]any{"id": "ws_remote", "name": "Remote", "localPath": "/nonexistent-on-server/remote-ws", "baseline": "main", "contextSummary": "", "acceptedCount": 0, "resolvedCount": 0},
	})
	readWSTypeForTest(t, conn, "registered")

	if _, err := server.SaveAttachments(context.Background(), "ws_remote", []feishu.MessageFile{{Name: "big.bin", Data: make([]byte, maxAttachmentUploadBytes+1)}}); err == nil {
		t.Fatal("a file over the upload limit was stored")
	}

	type result struct {
		saved []storepkg.ChatAttachment
		err   error
	}
	done := make(chan result, 1)
	go func() {
		saved, err := server.SaveAttachments(context.Background(), "ws_remote", []feishu.MessageFile{
			{Name: "image", MIMEType: "image/png", Data: []byte("png")},
			{Name: "测试数据.json", MIMEType: "application/octet-stream", Data: []byte("{}")},
		})
		done <- result{saved, err}
	}()
	for _, want := range []string{"_image.png", "_.json"} {
		var chunk wsAttachmentWritePayload
		id := readWSPayloadEnvelopeForTest(t, conn, "attachment_write", &chunk)
		data, _ := base64.StdEncoding.DecodeString(chunk.DataBase64)
		if !chunk.Final || !strings.HasSuffix(chunk.RelativePath, want) {
			t.Fatalf("chunk = %+v, want one final chunk named *%s", chunk, want)
		}
		writeWSIDForTest(t, conn, id, "attachment_written", map[string]any{"path": attachments + "/" + chunk.RelativePath, "size": len(data)})
	}
	got := <-done
	if got.err != nil || len(got.saved) != 2 {
		t.Fatalf("saved %+v, %v", got.saved, got.err)
	}
	if image := got.saved[0]; image.Kind != "image" || image.Name != "image.png" || image.Size != 3 || !strings.HasPrefix(image.Path, attachments+"/") {
		t.Fatalf("image = %+v, want an image attachment on the device", image)
	}
	if file := got.saved[1]; file.Kind != "file" || file.MIMEType != "application/json" || got.saved[0].ID == file.ID {
		t.Fatalf("file = %+v, want a distinct JSON file typed by its extension", file)
	}
}

func TestAnUnnamedImageGetsItsUsualExtension(t *testing.T) {
	for mimeType, want := range map[string]string{"image/jpeg": "image.jpg", "image/png": "image.png", "text/plain": "image"} {
		if got := ensureAttachmentExtension("image", mimeType); got != want {
			t.Errorf("%s: %q, want %q", mimeType, got, want)
		}
	}
}
