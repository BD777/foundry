package skillrepo

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type tarEntry struct {
	name, body, link string
}

func npmTarball(t *testing.T, entries []tarEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	compressed := gzip.NewWriter(&buffer)
	archive := tar.NewWriter(compressed)
	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Mode: 0o644, Size: int64(len(entry.body)), Typeflag: tar.TypeReg}
		if entry.link != "" {
			header = &tar.Header{Name: entry.name, Mode: 0o777, Typeflag: tar.TypeSymlink, Linkname: entry.link}
		}
		if err := archive.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if entry.link == "" {
			if _, err := archive.Write([]byte(entry.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// fakeRegistry serves one package's versions; tamper names versions whose
// advertised integrity does not match their tarball.
func fakeRegistry(t *testing.T, name string, versions map[string][]byte, latest string, tamper map[string]bool) *httptest.Server {
	t.Helper()
	escaped := strings.Replace(name, "/", "%2f", 1)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.EscapedPath() == "/"+escaped || r.URL.Path == "/"+name:
			docs := map[string]any{}
			for version, tarball := range versions {
				sum := sha512.Sum512(tarball)
				if tamper[version] {
					sum = sha512.Sum512([]byte("other"))
				}
				docs[version] = map[string]any{"version": version, "dist": map[string]string{
					"tarball":   server.URL + "/tarballs/" + version + ".tgz",
					"integrity": "sha512-" + base64.StdEncoding.EncodeToString(sum[:]),
				}}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"dist-tags": map[string]string{"latest": latest}, "versions": docs})
		case strings.HasSuffix(r.URL.Path, "/latest"):
			_ = json.NewEncoder(w).Encode(map[string]string{"version": latest, "description": "Browser automation CLI"})
		case strings.HasPrefix(r.URL.Path, "/tarballs/"):
			_, _ = w.Write(versions[strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/tarballs/"), ".tgz")])
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestNPMSourceFollowsAPackage(t *testing.T) {
	ctx := context.Background()
	remote, label, err := NormalizeURL("npm:@acme/browse")
	if err != nil || remote != "npm:@acme/browse" || label != "npmjs.com/package/@acme/browse" {
		t.Fatalf("NormalizeURL = %q %q %v", remote, label, err)
	}
	for _, bad := range []string{"npm:", "npm:../x", "npm:Acme", "npm:@a/b/c"} {
		if _, _, err := NormalizeURL(bad); err == nil {
			t.Errorf("NormalizeURL(%q) accepted", bad)
		}
	}
	good := npmTarball(t, []tarEntry{
		{name: "package/package.json", body: `{"name":"@acme/browse","bin":{"browse":"cli.js"}}`},
		{name: "package/skills/browse/SKILL.md", body: "---\nname: browse\ndescription: Browse\n---\nv1\n"},
		{name: "package/skills/browse/escape", link: "/etc/passwd"},
		{name: "package/../outside.txt", body: "no"},
	})
	registry := fakeRegistry(t, "@acme/browse", map[string][]byte{"1.0.0": good, "1.1.0": good}, "1.0.0", map[string]bool{"1.1.0": true})
	source := Sources{Git: Git{}, NPM: NPM{Registry: registry.URL}}

	tag, commit, ok, err := source.LatestRelease(ctx, remote)
	if err != nil || !ok || tag != "1.0.0" || commit != "1.0.0" {
		t.Fatalf("LatestRelease = %q %q %v %v", tag, commit, ok, err)
	}
	if version, err := source.Resolve(ctx, remote, "1.1.0"); err != nil || version != "1.1.0" {
		t.Fatalf("Resolve exact = %q %v", version, err)
	}
	if _, err := source.Resolve(ctx, remote, "9.0.0"); err == nil {
		t.Fatal("Resolve accepted a version the package does not have")
	}
	if description, err := source.Describe(ctx, remote); err != nil || description != "Browser automation CLI" {
		t.Fatalf("Describe = %q %v", description, err)
	}

	checkout, err := source.Fetch(ctx, remote, "")
	if err != nil {
		t.Fatal(err)
	}
	defer checkout.Close()
	found, err := checkout.FindSkills("skills")
	if err != nil || len(found) != 1 || found[0].Name != "browse" {
		t.Fatalf("FindSkills = %+v %v", found, err)
	}
	if bins := NPMBins(checkout, "@acme/browse"); strings.Join(bins, ",") != "browse" {
		t.Fatalf("NPMBins = %v", bins)
	}
	if _, err := os.Lstat(filepath.Join(checkout.Dir, "skills/browse/escape")); err == nil {
		t.Fatal("a link from the tarball was written")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(checkout.Dir), "outside.txt")); err == nil {
		t.Fatal("a path leaving the package was written")
	}

	if _, err := source.Fetch(ctx, remote, "1.1.0"); err == nil || !strings.Contains(err.Error(), "integrity") {
		t.Fatalf("a tarball not matching its integrity was accepted: %v", err)
	}
}

func TestNPMRefusesTarballsOffTheRegistry(t *testing.T) {
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer elsewhere.Close()
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"dist-tags": map[string]string{"latest": "1.0.0"},
			"versions": map[string]any{"1.0.0": map[string]any{"dist": map[string]string{
				"tarball": elsewhere.URL + "/x.tgz", "integrity": "sha512-x",
			}}},
		})
	}))
	defer registry.Close()
	if _, err := (NPM{Registry: registry.URL}).Fetch(context.Background(), "npm:x", ""); err == nil || !strings.Contains(err.Error(), "not on the registry") {
		t.Fatalf("Fetch = %v", err)
	}
}
