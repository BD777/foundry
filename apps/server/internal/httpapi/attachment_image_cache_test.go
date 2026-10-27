package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"
)

func TestAttachmentImagesCacheAndAuthorizeEveryRequest(t *testing.T) {
	f := newIsolationFixture(t)
	live := httptest.NewServer(f.handler)
	defer live.Close()
	data := append([]byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10}, bytes.Repeat([]byte{7}, 114988)...)
	var reads atomic.Int32
	device := connectFakeDevice(t, live, f.aliceDevice, map[string]any{"capabilities": []string{"attachment_image_v2"}, "device": map[string]any{"id": "dev_alice", "status": "connected"}, "workspace": map[string]any{"id": "ws_alice", "localPath": "/tmp/w", "name": "W"}}, map[string]fakeAnswer{wsAttachmentReadType: func(raw json.RawMessage) (string, any) {
		var r wsAttachmentReadPayload
		_ = json.Unmarshal(raw, &r)
		reads.Add(1)
		start := min(r.Offset, int64(len(data)))
		end := min(start+65536, int64(len(data)))
		return wsAttachmentChunkReadType, map[string]any{"size": len(data), "mimeType": "image/png", "realPath": "/canonical/w/.foundry/attachments/image.png", "revision": "inode:size:mtime", "dataBase64": base64.StdEncoding.EncodeToString(data[start:end])}
	}})
	target := "/api/local-files/image?path=" + url.QueryEscape("/tmp/w/.foundry/attachments/image.png")
	first := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, target, ""))
	expectStatus(t, first, http.StatusOK, "first image")
	if !bytes.Equal(first.Body.Bytes(), data) || first.Header().Get("ETag") == "" || first.Header().Get("Vary") != "Cookie, Authorization" || first.Header().Get("Cache-Control") != "private, max-age=300, must-revalidate" {
		t.Fatal("bad image/cache headers")
	}
	// Let the original requests drain before checking a cache hit does no IO.
	for i := 0; i < 100 && len(device.received(wsAttachmentReadType)) < 2; i++ {
		time.Sleep(time.Millisecond)
	}
	before := reads.Load()
	repeat := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, target, ""))
	expectStatus(t, repeat, http.StatusOK, "cached image")
	if !bytes.Equal(repeat.Body.Bytes(), data) || reads.Load() != before {
		t.Fatal("repeat reached the device")
	}
	conditional := f.as(f.alice, http.MethodGet, target, "")
	conditional.headers["If-None-Match"] = first.Header().Get("ETag")
	notModified := doAuthCall(t, f.handler, conditional)
	expectStatus(t, notModified, http.StatusNotModified, "etag")
	outsider := inviteAndJoin(t, f.handler, f.alice, store.RoleMember, "outsider-cache")
	denied := f.as(outsider, http.MethodGet, target, "")
	denied.headers["If-None-Match"] = first.Header().Get("ETag")
	hidden := doAuthCall(t, f.handler, denied)
	expectStatus(t, hidden, http.StatusNotFound, "cache must not bypass visibility")
	if bytes.Contains(hidden.Body.Bytes(), data) || reads.Load() != before {
		t.Fatal("cache leaked or unauthorized IO")
	}
	users, _ := f.server.store.(store.AccountStore).ListUsers(context.Background())
	var outsiderID string
	for _, user := range users {
		if user.Username == "outsider-cache" {
			outsiderID = user.ID
		}
	}
	ownership := f.server.store.(store.OwnershipStore)
	if err := ownership.SetWorkspaceMember(context.Background(), "ws_alice", outsiderID, store.WorkspaceRoleViewer, f.aliceID); err != nil {
		t.Fatal(err)
	}
	allowed := doAuthCall(t, f.handler, denied)
	expectStatus(t, allowed, http.StatusNotModified, "authorized cached conditional")
	if err := ownership.RemoveWorkspaceMember(context.Background(), "ws_alice", outsiderID); err != nil {
		t.Fatal(err)
	}
	revoked := doAuthCall(t, f.handler, denied)
	expectStatus(t, revoked, http.StatusNotFound, "revoked viewer cannot use etag")

}

func TestAttachmentImageCacheCoalescesCancellationAndNeverCachesErrors(t *testing.T) {
	var c attachmentImageCache
	calls := 0
	started, release := make(chan struct{}), make(chan struct{})
	load := func(context.Context) (*cachedAttachmentImage, error) {
		calls++
		close(started)
		<-release
		return &cachedAttachmentImage{data: []byte("png"), mime: "image/png", realPath: "/image", revision: "v1"}, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	wait := make(chan error, 1)
	go func() { _, err := c.read(ctx, "a", "device", load); wait <- err }()
	<-started
	cancel()
	if !errors.Is(<-wait, context.Canceled) {
		t.Fatal("viewer cancellation ignored")
	}
	close(release)
	image, err := c.read(context.Background(), "a", "device", load)
	if err != nil || string(image.data) != "png" || calls != 1 {
		t.Fatal("shared read lost")
	}
	c.mu.Lock()
	image.expires = time.Now().Add(-time.Second)
	c.mu.Unlock()
	failed := func(context.Context) (*cachedAttachmentImage, error) { return nil, errors.New("missing") }
	if _, err = c.read(context.Background(), "a", "device", failed); err == nil {
		t.Fatal("expired entry ignored")
	}
	changed, err := c.read(context.Background(), "a", "device", func(context.Context) (*cachedAttachmentImage, error) {
		return &cachedAttachmentImage{data: []byte("new"), realPath: "/image", revision: "v2"}, nil
	})
	if err != nil || string(changed.data) != "new" || changed.etag == image.etag {
		t.Fatal("failure cached or revision lost")
	}
	// LRU/alias accounting is bounded even for many immutable paths.
	for n := 0; n < attachmentImageCacheEntries+20; n++ {
		alias := string(rune(n + 100))
		_, err = c.read(context.Background(), alias, "device", func(context.Context) (*cachedAttachmentImage, error) {
			return &cachedAttachmentImage{data: []byte{1}, realPath: alias, revision: "v1"}, nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(c.entries) > attachmentImageCacheEntries || c.bytes > attachmentImageCacheBytes {
		t.Fatal("unbounded cache")
	}
}

func TestFileChunkPipelineOverlapsAndPreservesOrder(t *testing.T) {
	var active, peak atomic.Int32
	end := int64(8)
	var order []int64
	err := pipelineFileChunks(context.Background(), 0, 1, &end, func(ctx context.Context, offset int64) (int64, error) {
		now := active.Add(1)
		for {
			p := peak.Load()
			if p >= now || peak.CompareAndSwap(p, now) {
				break
			}
		}
		defer active.Add(-1)
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(time.Duration(8-offset) * time.Millisecond):
			return offset, nil
		}
	}, func(offset, value int64) error {
		if offset != value {
			t.Fatal("wrong offset")
		}
		order = append(order, value)
		return nil
	})
	if err != nil || peak.Load() != 4 || len(order) != 8 {
		t.Fatalf("pipeline peak=%d order=%v err=%v", peak.Load(), order, err)
	}
	for i, v := range order {
		if int64(i) != v {
			t.Fatal("out of order")
		}
	}
}
