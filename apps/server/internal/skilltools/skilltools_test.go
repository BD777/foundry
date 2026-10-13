package skilltools

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A GitHub release's downloads become one tool named after the repository,
// with one asset per supported platform and the checksums file.
func TestReleaseTools(t *testing.T) {
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/acme/tools/releases/tags/v1.0.0":
			_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v1.0.0", "assets": []map[string]string{
				{"name": "tools_v1.0.0_linux-amd64.tar.gz", "browser_download_url": "https://example.test/linux"},
				{"name": "tools_v1.0.0_linux-x86_64.tar.gz", "browser_download_url": "https://example.test/linux-again"},
				{"name": "tools_v1.0.0_darwin-arm64", "browser_download_url": "https://example.test/darwin"},
				{"name": "tools_v1.0.0_linux-arm64.deb", "browser_download_url": "https://example.test/deb"},
				{"name": "tools_v1.0.0_windows-amd64.zip", "browser_download_url": "https://example.test/windows"},
				{"name": "checksums.txt", "browser_download_url": "https://example.test/checksums"},
			}})
		case "/repos/acme/tools/releases/tags/v2.0.0":
			http.Error(w, "rate limited", http.StatusForbidden)
		default:
			http.NotFound(w, r)
		}
	}))
	defer github.Close()
	resolver := Resolver{ReleaseAPI: github.URL}
	ctx := context.Background()

	tools, err := resolver.releaseTools(ctx, "github.com/acme/tools", "v1.0.0")
	if err != nil || len(tools) != 1 {
		t.Fatalf("tools %+v, %v", tools, err)
	}
	tool := tools[0]
	want := []store.SkillToolAsset{
		{OS: "linux", Arch: "amd64", Name: "tools_v1.0.0_linux-amd64.tar.gz", URL: "https://example.test/linux"},
		{OS: "darwin", Arch: "arm64", Name: "tools_v1.0.0_darwin-arm64", URL: "https://example.test/darwin"},
	}
	if tool.Name != "tools" || tool.Version != "v1.0.0" || tool.ChecksumsURL != "https://example.test/checksums" || len(tool.Assets) != len(want) {
		t.Fatalf("tool %+v", tool)
	}
	for i := range want {
		if tool.Assets[i] != want[i] {
			t.Fatalf("asset %d = %+v, want %+v", i, tool.Assets[i], want[i])
		}
	}
	for _, none := range []struct{ label, tag string }{
		{"gitlab.com/acme/tools", "v1.0.0"},
		{"github.com/acme/tools", "main"},
		{"github.com/acme/tools", "v1.1.0"},
	} {
		if tools, err := resolver.releaseTools(ctx, none.label, none.tag); err != nil || tools != nil {
			t.Fatalf("%s@%s: %+v, %v", none.label, none.tag, tools, err)
		}
	}
	if _, err := resolver.releaseTools(ctx, "github.com/acme/tools", "v2.0.0"); err == nil || !strings.Contains(err.Error(), "GitHub answered") {
		t.Fatalf("GitHub refusing answered %v", err)
	}
}

// A Python tool takes the PyPI release matching the bundle's version, else
// PyPI's latest; a yanked or unusable version is not taken.
func TestPyPIVersion(t *testing.T) {
	latest := "0.13.12"
	pypi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		info := map[string]any{}
		switch r.URL.Path {
		case "/pypi/browser-use/json", "/pypi/yanked/json", "/pypi/odd/json":
			info["version"] = latest
			info["yanked"] = strings.Contains(r.URL.Path, "yanked")
			if strings.Contains(r.URL.Path, "odd") {
				info["version"] = "../1"
			}
		case "/pypi/browser-use/0.13.11/json":
			info["version"] = "0.13.11"
		case "/pypi/down/json":
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		default:
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"info": info})
	}))
	defer pypi.Close()
	resolver := Resolver{PyPIAPI: pypi.URL}
	ctx := context.Background()

	for _, tc := range []struct{ pkg, bundle, want string }{
		{"browser-use", "v0.13.11", "0.13.11"},
		{"browser-use", "0.14.0", latest},
		{"browser-use", "main", latest},
	} {
		if got, err := resolver.pypiVersion(ctx, tc.pkg, tc.bundle); err != nil || got != tc.want {
			t.Fatalf("%s at %s = %q, %v; want %q", tc.pkg, tc.bundle, got, err, tc.want)
		}
	}
	if _, err := resolver.pypiVersion(ctx, "yanked", "main"); !errors.Is(err, errNoPyPIRelease) {
		t.Fatalf("yanked: %v", err)
	}
	if _, err := resolver.pypiVersion(ctx, "odd", "main"); err == nil || !strings.Contains(err.Error(), "unusable version") {
		t.Fatalf("odd version: %v", err)
	}
	if _, err := resolver.pypiVersion(ctx, "down", "main"); err == nil || !strings.Contains(err.Error(), "PyPI answered") {
		t.Fatalf("PyPI down: %v", err)
	}
}

// Declared tools install with uv or npm, under a command named once,
// defaulting to the package's name without its scope.
func TestCheckDeclarations(t *testing.T) {
	clean, err := CheckDeclarations([]store.SkillToolDeclaration{
		{Source: " npm ", Package: "@acme/cli"},
		{Source: "uv", Package: "browser-use", Command: "bu"},
	})
	if err != nil || len(clean) != 2 || clean[0] != (store.SkillToolDeclaration{Source: "npm", Package: "@acme/cli", Command: "cli"}) {
		t.Fatalf("clean %+v, %v", clean, err)
	}
	for _, bad := range [][]store.SkillToolDeclaration{
		{{Source: "pip", Package: "browser-use"}},
		{{Source: "uv", Package: "browser use"}},
		{{Source: "npm", Package: "Upper"}},
		{{Source: "uv", Package: "browser-use", Command: "../bin"}},
		{{Source: "uv", Package: "a"}, {Source: "uv", Package: "a"}},
		{{Source: "uv", Package: "a"}, {Source: "uv", Package: "b"}, {Source: "uv", Package: "c"}, {Source: "uv", Package: "d"}, {Source: "uv", Package: "e"}},
	} {
		if _, err := CheckDeclarations(bad); err == nil {
			t.Fatalf("%+v was accepted", bad)
		}
	}
}
