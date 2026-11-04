package httpapi

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"
)

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// noisePNG compresses badly, like a photo: megabytes for a modest size.
func noisePNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	random := rand.New(rand.NewSource(7))
	_, _ = random.Read(img.Pix)
	for i := 3; i < len(img.Pix); i += 4 {
		img.Pix[i] = 255
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestDerivedImagesFitTheirBudgetKeepTheirShapeAndFlattenTransparency(t *testing.T) {
	data := noisePNG(t, 1200, 900)
	preview, err := deriveAttachmentImage(data, "preview")
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := jpeg.Decode(bytes.NewReader(preview))
	if err != nil {
		t.Fatal(err)
	}
	size := decoded.Bounds().Size()
	if len(preview) > imageVariantBudget("preview") || size.X > 1000 || size.X < size.Y || abs(size.X*3-size.Y*4) > 4 {
		t.Fatalf("preview %d bytes, %v", len(preview), size)
	}
	placeholder, err := deriveAttachmentImage(data, "placeholder")
	if err != nil || len(placeholder) > imageVariantBudget("placeholder") {
		t.Fatalf("placeholder %d bytes, %v", len(placeholder), err)
	}

	clear := image.NewNRGBA(image.Rect(0, 0, 300, 200))
	var transparent bytes.Buffer
	_ = png.Encode(&transparent, clear)
	flat, err := deriveAttachmentImage(transparent.Bytes(), "preview")
	if err != nil {
		t.Fatal(err)
	}
	decoded, _ = jpeg.Decode(bytes.NewReader(flat))
	if r, g, b, _ := decoded.At(10, 10).RGBA(); r>>8 < 245 || g>>8 < 245 || b>>8 < 245 {
		t.Fatalf("transparency became %v", color.RGBAModel.Convert(decoded.At(10, 10)))
	}
	if _, err := deriveAttachmentImage([]byte("not an image"), "preview"); err != errImageNotDerivable {
		t.Fatalf("garbage: %v", err)
	}
}

// A device without an image tool answers a preview request with the
// original. The viewer still gets a small preview, and opening the full
// image afterwards is served from what the server already read.
func TestPreviewOfAnOriginalIsDerivedAndTheOriginalReadOnce(t *testing.T) {
	f := newIsolationFixture(t)
	live := httptest.NewServer(f.handler)
	defer live.Close()
	data := noisePNG(t, 800, 600)
	var reads atomic.Int32
	connectFakeDevice(t, live, f.aliceDevice, map[string]any{"capabilities": []string{"attachment_image_v2"}, "device": map[string]any{"id": "dev_alice", "status": "connected"}, "workspace": map[string]any{"id": "ws_alice", "localPath": "/tmp/w", "name": "W"}}, map[string]fakeAnswer{wsAttachmentReadType: func(raw json.RawMessage) (string, any) {
		var r wsAttachmentReadPayload
		_ = json.Unmarshal(raw, &r)
		reads.Add(1)
		start := min(r.Offset, int64(len(data)))
		end := min(start+65536, int64(len(data)))
		return wsAttachmentChunkReadType, map[string]any{"size": len(data), "mimeType": "image/png", "realPath": "/canonical/w/.foundry/attachments/photo.png", "revision": "inode:size:mtime", "dataBase64": base64.StdEncoding.EncodeToString(data[start:end])}
	}})
	target := "/api/local-files/image?path=" + url.QueryEscape("/tmp/w/.foundry/attachments/photo.png")

	preview := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, target+"&variant=preview", ""))
	expectStatus(t, preview, http.StatusOK, "preview")
	if preview.Body.Len() > imageVariantBudget("preview") || preview.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("preview %d bytes as %q", preview.Body.Len(), preview.Header().Get("Content-Type"))
	}
	for i := 0; i < 100 && reads.Load() < int32((len(data)+65535)/65536); i++ {
		time.Sleep(time.Millisecond)
	}
	before := reads.Load()
	original := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, target, ""))
	expectStatus(t, original, http.StatusOK, "original")
	if !bytes.Equal(original.Body.Bytes(), data) {
		t.Fatal("the original differs from what the device sent")
	}
	if reads.Load() != before {
		t.Fatalf("the original was read from the device again (%d more reads)", reads.Load()-before)
	}
}
