package skilltools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type githubRelease struct {
	TagName string `json:"tag_name"`
	Assets  []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

var (
	toolOS = map[string]string{"linux": "linux", "darwin": "darwin", "macos": "darwin", "apple-darwin": "darwin"}
	// Longer names first, so "x86_64" is not read as "x86".
	toolArch = []struct{ token, arch string }{
		{"x86_64", "amd64"}, {"amd64", "amd64"}, {"aarch64", "arm64"}, {"arm64", "arm64"},
	}
	toolArchive  = regexp.MustCompile(`\.(tar\.gz|tgz|zip)$`)
	checksumName = regexp.MustCompile(`(?i)^(checksums?|sha256sums?)(\.txt)?$|(?i)checksums\.txt$`)
)

// toolAssets picks a release's downloads of tool for linux and macOS on
// amd64 and arm64: archives (or bare binaries) named after the tool, the
// platform and the architecture.
func toolAssets(release githubRelease, tool string) ([]store.SkillToolAsset, string) {
	var assets []store.SkillToolAsset
	checksums := ""
	seen := map[string]bool{}
	for _, asset := range release.Assets {
		name := strings.ToLower(asset.Name)
		if checksumName.MatchString(asset.Name) {
			checksums = asset.URL
			continue
		}
		if !strings.HasPrefix(name, strings.ToLower(tool)) || strings.HasSuffix(name, ".sha256") || strings.HasSuffix(name, ".sig") {
			continue
		}
		osName := ""
		for token, value := range toolOS {
			if strings.Contains(name, token) {
				osName = value
			}
		}
		arch := ""
		for _, candidate := range toolArch {
			if strings.Contains(name, candidate.token) {
				arch = candidate.arch
				break
			}
		}
		if osName == "" || arch == "" || seen[osName+"/"+arch] {
			continue
		}
		if !toolArchive.MatchString(name) && strings.Contains(path0(name), ".") {
			continue
		}
		seen[osName+"/"+arch] = true
		assets = append(assets, store.SkillToolAsset{OS: osName, Arch: arch, Name: asset.Name, URL: asset.URL})
	}
	return assets, checksums
}

// path0 is the name after its tool/platform part, to tell a bare binary
// ("tool_linux_amd64") from an unknown file type ("tool_linux_amd64.deb").
func path0(name string) string {
	if i := strings.LastIndexAny(name, "_-"); i >= 0 {
		return name[i+1:]
	}
	return name
}

// releaseTools finds the program a bundle's GitHub repository publishes for
// its release tag: the repository's name, with downloads per platform.
// Repositories elsewhere, branches and releases without matching downloads
// have none.
func (r Resolver) releaseTools(ctx context.Context, label, tag string) ([]store.SkillBundleTool, error) {
	owner, repo, ok := strings.Cut(strings.TrimPrefix(label, "github.com/"), "/")
	if !strings.HasPrefix(label, "github.com/") || !ok || strings.Contains(repo, "/") || !semverLike(tag) {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	endpoint := fmt.Sprintf("%s/repos/%s/%s/releases/tags/%s", r.ReleaseAPI, url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(tag))
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub answered %s", response.Status)
	}
	var release githubRelease
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&release); err != nil {
		return nil, err
	}
	assets, checksums := toolAssets(release, repo)
	if len(assets) == 0 {
		return []store.SkillBundleTool{}, nil
	}
	return []store.SkillBundleTool{{Name: repo, Version: tag, Assets: assets, ChecksumsURL: checksums}}, nil
}
