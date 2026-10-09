package skillrepo

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDescribeReadsGitHubDescriptionAndIgnoresOtherHosts(t *testing.T) {
	var asked string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.Path
		if r.URL.Path == "/repos/riba2534/missing" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"description":"  Feishu CLI and its agent skills  ","name":"feishu-cli"}`))
	}))
	defer server.Close()
	previous := githubAPI
	githubAPI = server.URL
	t.Cleanup(func() { githubAPI = previous })

	got, err := Describe(context.Background(), "https://github.com/riba2534/feishu-cli")
	if err != nil || got != "Feishu CLI and its agent skills" || asked != "/repos/riba2534/feishu-cli" {
		t.Fatalf("Describe = %q, %v (asked %s)", got, err, asked)
	}
	if _, err := Describe(context.Background(), "https://github.com/riba2534/missing"); err == nil {
		t.Fatal("a repository GitHub does not know was described")
	}
	asked = ""
	if got, err := Describe(context.Background(), "https://gitlab.com/group/repo"); got != "" || err != nil || asked != "" {
		t.Fatalf("another host was asked: %q, %v, %s", got, err, asked)
	}
}
