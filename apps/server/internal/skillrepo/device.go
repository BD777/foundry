package skillrepo

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

// A device reads a repository with its own git settings and credentials, so
// it may use an ssh remote: ssh://[user@]host[:port]/path or the scp-like
// [user@]host:path.
var (
	scpRemote = regexp.MustCompile(`^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9][A-Za-z0-9.-]*):([A-Za-z0-9._~/-]+)$`)
	sshUser   = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	hostName  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]*$`)
)

// NormalizeDeviceURL accepts what NormalizeURL does and, because a device
// reads it with its own keys, an ssh remote. The label is host/path either
// way, so https and ssh name a repository alike.
func NormalizeDeviceURL(raw string) (remote, label string, err error) {
	raw = strings.TrimSpace(raw)
	if IsNPM(raw) {
		return NormalizeURL(raw)
	}
	if match := scpRemote.FindStringSubmatch(raw); match != nil && !strings.Contains(raw, "://") {
		return sshRemote(raw, match[2], match[3])
	}
	parsed, parseErr := url.Parse(raw)
	if parseErr == nil && parsed.Scheme == "ssh" {
		if parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" || !hostName.MatchString(parsed.Hostname()) {
			return "", "", errors.New("the ssh URL names no host")
		}
		if _, hasPassword := parsed.User.Password(); hasPassword || (parsed.User != nil && !sshUser.MatchString(parsed.User.Username())) {
			return "", "", errors.New("the ssh URL must not carry a password")
		}
		return sshRemote(raw, parsed.Hostname(), parsed.Path)
	}
	return NormalizeURL(raw)
}

func sshRemote(raw, host, repoPath string) (string, string, error) {
	repoPath = strings.TrimSuffix(strings.Trim(repoPath, "/"), ".git")
	if repoPath == "" || strings.HasPrefix(repoPath, "-") || strings.Contains(repoPath, "..") {
		return "", "", errors.New("the ssh URL names no repository")
	}
	return raw, strings.ToLower(host) + "/" + repoPath, nil
}

// IsSSH reports whether remote is an ssh remote, which only a device reads.
func IsSSH(remote string) bool {
	return strings.HasPrefix(remote, "ssh://") || (!IsNPM(remote) && !strings.Contains(remote, "://") && scpRemote.MatchString(remote))
}

// CleanRegistry checks an npm registry address: empty, or an https URL
// without credentials, query or fragment. It returns it without a trailing
// slash.
func CleanRegistry(raw string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" {
		return "", nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("the npm registry must be an https:// address without credentials")
	}
	return parsed.String(), nil
}

// unreachable are git's and Go's words for a host that did not answer.
var unreachable = []string{
	"could not resolve host", "failed to connect", "connection timed out", "connection refused",
	"network is unreachable", "no route to host", "no such host", "i/o timeout", "operation timed out",
	"eai_again", "enotfound", "etimedout", "econnrefused",
}

// Unreachable reports whether a failure means the host could not be reached
// at all (name, network or connection), not that it refused the request.
func Unreachable(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	for _, words := range unreachable {
		if strings.Contains(message, words) {
			return true
		}
	}
	return false
}

// Host is the host part of a remote, for messages: "github.com",
// "code.byted.org", or the package name of an npm remote.
func Host(remote string) string {
	if IsNPM(remote) {
		return NPMPackage(remote)
	}
	if match := scpRemote.FindStringSubmatch(remote); match != nil && IsSSH(remote) {
		return match[2]
	}
	if parsed, err := url.Parse(remote); err == nil && parsed.Host != "" {
		return parsed.Hostname()
	}
	return remote
}

// CheckoutFromTree unpacks the files a device took from a repository (a zip
// whose paths are relative to the repository root) into a temporary
// checkout at commit. Only regular files with clean paths are written,
// within the limits of a skill package.
func CheckoutFromTree(data []byte, commit string) (*Checkout, error) {
	if len(data) > maxTarball {
		return nil, errors.New("the repository's skill files are larger than the limit")
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("the device sent unreadable files: %w", err)
	}
	dir, err := os.MkdirTemp("", "foundry-device-repo-")
	if err != nil {
		return nil, err
	}
	checkout := &Checkout{Dir: dir, Commit: commit}
	var total uint64
	for _, file := range reader.File {
		if file.FileInfo().IsDir() {
			continue
		}
		clean, err := CleanSubpath(file.Name)
		if err != nil || clean == "" || clean != file.Name || path.IsAbs(file.Name) || !file.Mode().IsRegular() ||
			strings.Contains(clean, "/.git/") || strings.HasPrefix(clean, ".git/") {
			checkout.Close()
			return nil, fmt.Errorf("the device sent an unsafe path %q", file.Name)
		}
		total += file.UncompressedSize64
		if file.UncompressedSize64 > maxTarballFile || total > maxTarball {
			checkout.Close()
			return nil, errors.New("the repository's skill files are larger than the limit")
		}
		if err := writeTreeFile(dir, clean, file); err != nil {
			checkout.Close()
			return nil, err
		}
	}
	return checkout, nil
}

func writeTreeFile(dir, rel string, file *zip.File) error {
	target := filepath.Join(dir, filepath.FromSlash(rel))
	if !strings.HasPrefix(target, dir+string(filepath.Separator)) {
		return fmt.Errorf("the device sent an unsafe path %q", rel)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	source, err := file.Open()
	if err != nil {
		return err
	}
	defer source.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("the device sent %q twice or under a file: %w", rel, err)
	}
	written, copyErr := io.Copy(out, io.LimitReader(source, maxTarballFile+1))
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if written > maxTarballFile {
		return errors.New("the repository's skill files are larger than the limit")
	}
	return closeErr
}

// CheckoutFromPackage unpacks an npm package tarball a device downloaded
// (with its own npm settings, which checked the registry's integrity hash)
// into a temporary checkout at version, like Fetch does for the server.
func CheckoutFromPackage(tarball []byte, version string) (*Checkout, error) {
	if len(tarball) > maxTarball {
		return nil, errors.New("the package is larger than the limit")
	}
	dir, err := os.MkdirTemp("", "foundry-device-package-")
	if err != nil {
		return nil, err
	}
	checkout := &Checkout{Dir: dir, Commit: version}
	if err := extractPackage(tarball, dir); err != nil {
		checkout.Close()
		return nil, err
	}
	return checkout, nil
}

// NPMVersion picks the version ref names among a package's dist-tags and
// versions: "" is the latest dist-tag, a dist-tag names its version, and an
// exact version is itself.
func NPMVersion(name string, distTags map[string]string, versions []string, ref string) (string, error) {
	version := ref
	if ref == "" {
		ref = "latest"
	}
	if tagged, ok := distTags[ref]; ok {
		version = tagged
	}
	for _, known := range versions {
		if known == version && version != "" {
			return version, nil
		}
	}
	return "", fmt.Errorf("%s has no version or dist-tag %q", name, ref)
}
