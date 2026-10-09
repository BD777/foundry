package skillrepo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// githubAPI is where repository descriptions are read; tests point it at a
// local server.
var githubAPI = "https://api.github.com"

// Describe returns the repository's own one-line description as its host
// publishes it. Only github.com is asked (unauthenticated); other hosts and
// repositories without one give "".
func Describe(ctx context.Context, remote string) (string, error) {
	parsed, err := url.Parse(remote)
	if err != nil || !strings.EqualFold(parsed.Host, "github.com") {
		return "", nil
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) != 2 {
		return "", nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/repos/%s/%s", githubAPI, url.PathEscape(parts[0]), url.PathEscape(strings.TrimSuffix(parts[1], ".git"))), nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "foundry-skill-library")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("github answered %s", response.Status)
	}
	var body struct {
		Description string `json:"description"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&body); err != nil {
		return "", err
	}
	return strings.TrimSpace(body.Description), nil
}

func (Git) Describe(ctx context.Context, remote string) (string, error) {
	return Describe(ctx, remote)
}
