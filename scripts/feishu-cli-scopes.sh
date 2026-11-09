#!/usr/bin/env bash
# Prints the scope set Foundry asks for on a Feishu login for one feishu-cli
# release, as the JSON entry for that tag in
# apps/server/internal/externalaccounts/feishu_cli_scopes.json:
#   recommended  what `feishu-cli auth login --recommend` asks for (every
#                domain, recommended scopes only), from feishu-cli's own
#                embedded registry with FEISHU_CLI_REMOTE_META=off;
#   skill        scopes the release's skills request by name
#                (`auth login --scope "…"`) that feishu-cli auto-approves but
#                does not recommend;
#   approval     scopes the skills request by name that a tenant
#                administrator may have to approve.
# This is feishu-cli's list for that release, not a catalogue of every
# Feishu scope. Usage: scripts/feishu-cli-scopes.sh v1.44.0
set -euo pipefail
tag="${1:?usage: $0 <feishu-cli release tag, e.g. v1.44.0>}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git -c advice.detachedHead=false clone -q --depth 1 --branch "$tag" https://github.com/riba2534/feishu-cli "$work/src"
commit="$(git -C "$work/src" rev-parse --short HEAD)"
mkdir -p "$work/src/cmd/foundryscopes"
cat > "$work/src/cmd/foundryscopes/main.go" <<'GO'
package main

import (
	"encoding/json"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/riba2534/feishu-cli/internal/auth"
	"github.com/riba2534/feishu-cli/internal/registry"
)

func main() {
	recommended, err := auth.CollectDomainScopes(auth.KnownScopeDomainNames(), true)
	if err != nil {
		panic(err)
	}
	sort.Strings(recommended)
	inRecommended := map[string]bool{}
	for _, scope := range recommended {
		inRecommended[scope] = true
	}
	named := map[string]bool{}
	scopeFlag := regexp.MustCompile(`--scope[ =]+["']([^"']+)["']`)
	scopeName := regexp.MustCompile(`^[a-z][a-z0-9_]*:[a-z0-9_.:-]+$`)
	_ = filepathWalk("skills", func(path string, data []byte) {
		for _, match := range scopeFlag.FindAllStringSubmatch(string(data), -1) {
			for _, scope := range strings.FieldsFunc(match[1], func(r rune) bool { return r == ' ' || r == ',' }) {
				if scopeName.MatchString(scope) && scope != "offline_access" {
					named[scope] = true
				}
			}
		}
	})
	skill, approval := []string{}, []string{}
	for scope := range named {
		switch {
		case inRecommended[scope]:
		case registry.IsAutoApproveScope(scope):
			skill = append(skill, scope)
		default:
			approval = append(approval, scope)
		}
	}
	sort.Strings(skill)
	sort.Strings(approval)
	out := json.NewEncoder(os.Stdout)
	out.SetIndent("", "  ")
	_ = out.Encode(map[string]any{"commit": os.Getenv("FOUNDRY_SCOPES_COMMIT"), "recommended": recommended, "skill": skill, "approval": approval})
}
GO
cat > "$work/src/cmd/foundryscopes/walk.go" <<'GO'
package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func filepathWalk(root string, visit func(path string, data []byte)) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(path, ".md") {
			return err
		}
		data, err := os.ReadFile(path)
		if err == nil {
			visit(path, data)
		}
		return nil
	})
}
GO
cd "$work/src"
echo "feishu-cli $tag ($commit)" >&2
FOUNDRY_SCOPES_COMMIT="$commit" FEISHU_CLI_REMOTE_META=off GOFLAGS=-mod=mod go run ./cmd/foundryscopes
