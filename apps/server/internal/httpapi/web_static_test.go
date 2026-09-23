package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testIndexHTML = "<html><body><div id=\"root\">foundry-web</div></body></html>"

func newWebDistServer(t *testing.T, options ServerOptions) *Server {
	t.Helper()

	distDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(distDir, "index.html"), []byte(testIndexHTML), 0o600); err != nil {
		t.Fatalf("write index.html: %v", err)
	}
	if err := os.Mkdir(filepath.Join(distDir, "assets"), 0o700); err != nil {
		t.Fatalf("mkdir assets: %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(distDir, "assets", "index-abc123.js"),
		[]byte("console.log('foundry')"),
		0o600,
	); err != nil {
		t.Fatalf("write asset: %v", err)
	}

	options.WebDistDir = distDir
	return NewServerWithOptions(newTestStore(t), options)
}

func TestWebStaticServesIndexAtRoot(t *testing.T) {
	server := newWebDistServer(t, ServerOptions{})

	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, response.Code)
	}
	if !strings.Contains(response.Body.String(), "foundry-web") {
		t.Fatalf("expected index.html body, got %q", response.Body.String())
	}
}

func TestWebStaticSPAFallback(t *testing.T) {
	server := newWebDistServer(t, ServerOptions{})

	// Static assets must be reachable even when the server requires auth.
	assetResponse := httptest.NewRecorder()
	server.Routes().ServeHTTP(
		assetResponse,
		httptest.NewRequest(http.MethodGet, "/assets/index-abc123.js", nil),
	)
	if assetResponse.Code != http.StatusOK {
		t.Fatalf("expected asset status %d, got %d", http.StatusOK, assetResponse.Code)
	}
	if !strings.Contains(assetResponse.Body.String(), "console.log") {
		t.Fatalf("expected asset body, got %q", assetResponse.Body.String())
	}

	// Unknown client-side routes fall back to index.html, also without auth.
	for _, path := range []string{"/issues", "/workspaces/abc/chat"} {
		fallback := httptest.NewRecorder()
		server.Routes().ServeHTTP(fallback, httptest.NewRequest(http.MethodGet, path, nil))
		if fallback.Code != http.StatusOK {
			t.Fatalf("%s: expected status %d, got %d", path, http.StatusOK, fallback.Code)
		}
		if !strings.Contains(fallback.Body.String(), "foundry-web") {
			t.Fatalf("%s: expected index.html fallback, got %q", path, fallback.Body.String())
		}
	}

	// Missing hashed assets 404 instead of being masked by the HTML fallback.
	missingAsset := httptest.NewRecorder()
	server.Routes().ServeHTTP(
		missingAsset,
		httptest.NewRequest(http.MethodGet, "/assets/does-not-exist.js", nil),
	)
	if missingAsset.Code != http.StatusNotFound {
		t.Fatalf("expected missing asset status %d, got %d", http.StatusNotFound, missingAsset.Code)
	}
}

func TestWebStaticUnknownAPIReturnsJSON(t *testing.T) {
	server := withTestOwner(newWebDistServer(t, ServerOptions{}))

	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/does-not-exist", nil))

	if response.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d", http.StatusNotFound, response.Code)
	}
	var payload map[string]string
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	if payload["error"] == "" {
		t.Fatalf("expected JSON error body, got %q", response.Body.String())
	}
}
