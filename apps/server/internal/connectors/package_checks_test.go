package connectors

import (
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func packageFixture() store.ConnectorPackage {
	return store.ConnectorPackage{
		Upstream: store.ConnectorPackageUpstream{
			Via: "github", Repository: "https://github.com/nwverse/open-lark", Ref: "main",
		},
		Skills: store.ConnectorPackageSkills{Path: "plugins/open-lark/skills"},
		Tools: []store.ConnectorPackageTool{{
			Command: "olk", Source: "repository", Path: "plugins/open-lark",
			Bins: map[string]string{"olk": "bin/olk", "olk-ctx": "bin/olk-ctx"},
		}},
	}
}

func TestConnectorPackageNamesAReaderAndSafeUpstreamPaths(t *testing.T) {
	catalog := DefaultCatalog()
	if err := catalog.checkConnectorPackage(packageFixture(), nil); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*store.ConnectorPackage){
		"reader": func(pkg *store.ConnectorPackage) { pkg.Upstream.Via = "git" },
		"repository": func(pkg *store.ConnectorPackage) {
			pkg.Upstream.Repository = "http://github.com/acme/tools"
		},
		"skills path": func(pkg *store.ConnectorPackage) { pkg.Skills.Path = "../skills" },
		"tool path":   func(pkg *store.ConnectorPackage) { pkg.Tools[0].Path = "../tool" },
		"bin path":    func(pkg *store.ConnectorPackage) { pkg.Tools[0].Bins["olk"] = "../../bin/olk" },
		"primary bin": func(pkg *store.ConnectorPackage) { delete(pkg.Tools[0].Bins, "olk") },
	} {
		pkg := packageFixture()
		mutate(&pkg)
		if err := catalog.checkConnectorPackage(pkg, nil); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
