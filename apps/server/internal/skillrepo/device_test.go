package skillrepo

import (
	"archive/zip"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestNormalizeDeviceURL(t *testing.T) {
	for _, tc := range []struct{ raw, label string }{
		{"git@code.byted.org:byteapi/bytedcli.git", "code.byted.org/byteapi/bytedcli"},
		{"ssh://git@code.byted.org:29418/byteapi/bytedcli.git", "code.byted.org/byteapi/bytedcli"},
		{"https://code.byted.org/byteapi/bytedcli/", "code.byted.org/byteapi/bytedcli"},
		{"npm:@bytedance-dev/bytedcli", "npmjs.com/package/@bytedance-dev/bytedcli"},
	} {
		_, label, err := NormalizeDeviceURL(tc.raw)
		if err != nil || label != tc.label {
			t.Errorf("%s: label %q err %v, want %q", tc.raw, label, err, tc.label)
		}
	}
	for _, raw := range []string{"ssh://git:secret@host/x/y", "git@host:-oProxyCommand=x", "ext::sh -c x", "file:///etc", "git@host:../x"} {
		if _, _, err := NormalizeDeviceURL(raw); err == nil {
			t.Errorf("%s was accepted", raw)
		}
	}
	if _, _, err := NormalizeURL("git@code.byted.org:byteapi/bytedcli.git"); err == nil {
		t.Error("the server accepted an ssh remote")
	}
	if !IsSSH("git@code.byted.org:a/b.git") || !IsSSH("ssh://h/a/b") || IsSSH("https://h/a/b") || IsSSH("npm:agent-browser") {
		t.Error("IsSSH")
	}
}

func TestCleanRegistry(t *testing.T) {
	if got, err := CleanRegistry(" https://bnpm.byted.org/ "); err != nil || got != "https://bnpm.byted.org" {
		t.Fatalf("got %q %v", got, err)
	}
	for _, raw := range []string{"http://bnpm.byted.org", "https://user:token@bnpm.byted.org", "https://r.example/?a=1"} {
		if _, err := CleanRegistry(raw); err == nil {
			t.Errorf("%s was accepted", raw)
		}
	}
}

func TestUnreachable(t *testing.T) {
	if !Unreachable(errors.New("fatal: unable to access 'https://code.byted.org/x/': Could not resolve host: code.byted.org")) {
		t.Error("an unresolved host is unreachable")
	}
	if Unreachable(errors.New("git@code.byted.org: Permission denied (publickey).\nfatal: Could not read from remote repository.")) {
		t.Error("a refused key is not a network failure")
	}
}

func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	for name, body := range files {
		out, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = out.Write([]byte(body))
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestCheckoutFromTree(t *testing.T) {
	checkout, err := CheckoutFromTree(zipOf(t, map[string]string{
		"skills/a/SKILL.md": "---\nname: a\n---\n", "LICENSE": "MIT",
	}), "abc")
	if err != nil {
		t.Fatal(err)
	}
	defer checkout.Close()
	found, err := checkout.FindSkills("skills")
	if err != nil || len(found) != 1 || found[0].License != "see repository LICENSE" {
		t.Fatalf("found %+v %v", found, err)
	}
	for _, bad := range []string{"../escape", "/abs", "a/../../b", ".git/config", "a/./b"} {
		if checkout, err := CheckoutFromTree(zipOf(t, map[string]string{bad: "x"}), "abc"); err == nil {
			checkout.Close()
			t.Errorf("%s was written", bad)
		}
	}
	if _, err := os.Stat(filepath.Join(os.TempDir(), "escape")); err == nil {
		t.Error("a path left the checkout")
	}
}

func TestNPMVersion(t *testing.T) {
	tags := map[string]string{"latest": "1.2.0", "beta": "1.3.0-beta.1"}
	versions := []string{"1.2.0", "1.3.0-beta.1", "1.1.0"}
	for ref, want := range map[string]string{"": "1.2.0", "beta": "1.3.0-beta.1", "1.1.0": "1.1.0"} {
		if got, err := NPMVersion("p", tags, versions, ref); err != nil || got != want {
			t.Errorf("%q: %q %v", ref, got, err)
		}
	}
	if _, err := NPMVersion("p", tags, versions, "9.9.9"); err == nil {
		t.Error("an unknown version resolved")
	}
}
