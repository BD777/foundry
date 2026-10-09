package skillrepo

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// NPMPrefix marks a remote that is an npm package rather than a git
// repository: "npm:agent-browser", "npm:@playwright/cli". Such a package is
// followed like a repository: its versions are its releases and its tarball
// is the checkout, so skills shipped inside a CLI stay matched to it.
const NPMPrefix = "npm:"

var npmName = regexp.MustCompile(`^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$`)

// IsNPM reports whether remote names an npm package.
func IsNPM(remote string) bool { return strings.HasPrefix(remote, NPMPrefix) }

// NPMPackage is the package name of an npm remote.
func NPMPackage(remote string) string { return strings.TrimPrefix(remote, NPMPrefix) }

// normalizeNPM accepts "npm:<package>" and returns its remote and the label
// people see, the package's page on npmjs.com.
func normalizeNPM(raw string) (remote, label string, err error) {
	name := strings.TrimSpace(strings.TrimPrefix(raw, NPMPrefix))
	if len(name) > 214 || !npmName.MatchString(name) {
		return "", "", fmt.Errorf("%q is not an npm package name", name)
	}
	return NPMPrefix + name, "npmjs.com/package/" + name, nil
}

// maxTarball bounds a package download; maxTarballFile skips single files
// no skill needs (agent-browser ships ~15 MB native binaries per platform).
const (
	maxTarball     = 256 << 20
	maxTarballFile = 16 << 20
)

// NPM reads packages from an npm registry over https. Registry is the
// registry's base URL; empty is the public registry.
type NPM struct {
	Registry string
	Client   *http.Client
}

func (n NPM) registry() *url.URL {
	base := n.Registry
	if base == "" {
		base = "https://registry.npmjs.org"
	}
	parsed, _ := url.Parse(strings.TrimRight(base, "/"))
	return parsed
}

func (n NPM) client() *http.Client {
	if n.Client != nil {
		return n.Client
	}
	return http.DefaultClient
}

type npmVersion struct {
	Version     string                              `json:"version"`
	Description string                              `json:"description"`
	License     any                                 `json:"license"`
	Bin         any                                 `json:"bin"`
	Dist        struct{ Tarball, Integrity string } `json:"dist"`
}

type npmPackument struct {
	DistTags map[string]string     `json:"dist-tags"`
	Versions map[string]npmVersion `json:"versions"`
}

func (n NPM) get(ctx context.Context, address string, limit int64, accept string, into any) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", accept)
	request.Header.Set("User-Agent", "foundry-skill-library")
	response, err := n.client().Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return fmt.Errorf("npm has no package at %s", address)
	}
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("npm answered %s", response.Status)
	}
	return json.NewDecoder(io.LimitReader(response.Body, limit)).Decode(into)
}

// packageURL is the registry address of a package; a scoped name keeps its
// "@" and escapes its "/".
func (n NPM) packageURL(name string, rest ...string) string {
	escaped := strings.Replace(name, "/", "%2f", 1)
	return n.registry().String() + "/" + strings.Join(append([]string{escaped}, rest...), "/")
}

// packument reads the abbreviated package document: dist-tags and each
// version's tarball and integrity.
func (n NPM) packument(ctx context.Context, name string) (npmPackument, error) {
	var doc npmPackument
	err := n.get(ctx, n.packageURL(name), 64<<20, "application/vnd.npm.install-v1+json", &doc)
	return doc, err
}

// resolveVersion: ref "" is the latest dist-tag, a dist-tag names its
// version, and an exact version is itself.
func (n NPM) resolveVersion(ctx context.Context, name, ref string) (string, npmVersion, error) {
	doc, err := n.packument(ctx, name)
	if err != nil {
		return "", npmVersion{}, err
	}
	version := ref
	if ref == "" {
		ref = "latest"
	}
	if tagged, ok := doc.DistTags[ref]; ok {
		version = tagged
	}
	meta, ok := doc.Versions[version]
	if !ok {
		return "", npmVersion{}, fmt.Errorf("%s has no version or dist-tag %q", name, ref)
	}
	return version, meta, nil
}

// Resolve names the version ref points at; for a package, the version is
// what a git source calls its commit.
func (n NPM) Resolve(ctx context.Context, remote, ref string) (string, error) {
	version, _, err := n.resolveVersion(ctx, NPMPackage(remote), ref)
	return version, err
}

// LatestRelease is the version the "latest" dist-tag names.
func (n NPM) LatestRelease(ctx context.Context, remote string) (string, string, bool, error) {
	version, _, err := n.resolveVersion(ctx, NPMPackage(remote), "")
	if err != nil {
		return "", "", false, err
	}
	return version, version, true, nil
}

// Describe is the package's own description.
func (n NPM) Describe(ctx context.Context, remote string) (string, error) {
	var meta npmVersion
	if err := n.get(ctx, n.packageURL(NPMPackage(remote), "latest"), 4<<20, "application/json", &meta); err != nil {
		return "", err
	}
	return strings.TrimSpace(meta.Description), nil
}

// Fetch downloads the version ref points at, checks it against the
// registry's integrity hash and unpacks it. Nothing in the package runs.
func (n NPM) Fetch(ctx context.Context, remote, ref string) (*Checkout, error) {
	name := NPMPackage(remote)
	version, meta, err := n.resolveVersion(ctx, name, ref)
	if err != nil {
		return nil, err
	}
	tarball, err := url.Parse(meta.Dist.Tarball)
	registry := n.registry()
	if err != nil || tarball.Scheme != registry.Scheme || tarball.Host != registry.Host {
		return nil, fmt.Errorf("%s@%s's tarball is not on the registry", name, version)
	}
	algorithm, expected, ok := strings.Cut(meta.Dist.Integrity, "-")
	if !ok || algorithm != "sha512" {
		return nil, fmt.Errorf("%s@%s has no sha512 integrity hash", name, version)
	}
	dir, err := os.MkdirTemp("", "foundry-npm-package-")
	if err != nil {
		return nil, err
	}
	checkout := &Checkout{Dir: dir, Commit: version}
	if err := n.unpack(ctx, tarball.String(), expected, dir); err != nil {
		checkout.Close()
		return nil, fmt.Errorf("%s@%s: %w", name, version, err)
	}
	return checkout, nil
}

func (n NPM) unpack(ctx context.Context, address, integrity, dir string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return err
	}
	response, err := n.client().Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("the registry answered %s for the tarball", response.Status)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxTarball+1))
	if err != nil {
		return err
	}
	if len(data) > maxTarball {
		return errors.New("the package is larger than the limit")
	}
	sum := sha512.Sum512(data)
	if base64.StdEncoding.EncodeToString(sum[:]) != integrity {
		return errors.New("the tarball does not match the registry's integrity hash")
	}
	return extractPackage(data, dir)
}

// extractPackage writes a package tarball's regular files under dir,
// dropping the tarball's top folder ("package/"). Links, devices and paths
// leaving the folder are skipped, as are single files larger than any skill
// needs.
func extractPackage(data []byte, dir string) error {
	compressed, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return err
	}
	archive := tar.NewReader(compressed)
	for {
		header, err := archive.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if header.Typeflag != tar.TypeReg || header.Size > maxTarballFile {
			continue
		}
		_, rel, ok := strings.Cut(path.Clean(strings.TrimPrefix(header.Name, "./")), "/")
		if !ok || rel == "" || rel == ".." || strings.HasPrefix(rel, "../") || path.IsAbs(rel) {
			continue
		}
		target := filepath.Join(dir, filepath.FromSlash(rel))
		if !strings.HasPrefix(target, dir+string(filepath.Separator)) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		file, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(file, io.LimitReader(archive, maxTarballFile))
		closeErr := file.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
}

// NPMBins are the commands a package's package.json declares, by name.
func NPMBins(checkout *Checkout, packageName string) []string {
	data, err := os.ReadFile(filepath.Join(checkout.Dir, "package.json"))
	if err != nil {
		return nil
	}
	var manifest struct {
		Name string `json:"name"`
		Bin  any    `json:"bin"`
	}
	if json.Unmarshal(data, &manifest) != nil {
		return nil
	}
	switch bin := manifest.Bin.(type) {
	case string:
		return []string{path.Base(packageName)}
	case map[string]any:
		names := make([]string, 0, len(bin))
		for name := range bin {
			names = append(names, name)
		}
		return names
	}
	return nil
}

// Sources reads git repositories and npm packages, each by its remote.
type Sources struct {
	Git Source
	NPM Source
}

// DefaultSources reads public git repositories and the public npm registry.
func DefaultSources() Sources { return Sources{Git: Git{}, NPM: NPM{}} }

func (s Sources) pick(remote string) Source {
	if IsNPM(remote) && s.NPM != nil {
		return s.NPM
	}
	return s.Git
}

func (s Sources) Resolve(ctx context.Context, remote, ref string) (string, error) {
	return s.pick(remote).Resolve(ctx, remote, ref)
}

func (s Sources) Fetch(ctx context.Context, remote, ref string) (*Checkout, error) {
	return s.pick(remote).Fetch(ctx, remote, ref)
}

func (s Sources) LatestRelease(ctx context.Context, remote string) (string, string, bool, error) {
	return s.pick(remote).LatestRelease(ctx, remote)
}

func (s Sources) Describe(ctx context.Context, remote string) (string, error) {
	return s.pick(remote).Describe(ctx, remote)
}
