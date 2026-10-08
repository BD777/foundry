package httpapi

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
)

// workerReleaseManifest is release.json in ServerOptions.WorkerPackagesDir,
// written by scripts/pack-worker-release.mjs next to the package tarballs.
type workerReleaseManifest struct {
	Version  string `json:"version"`
	Packages []struct {
		Name string `json:"name"`
		File string `json:"file"`
	} `json:"packages"`
}

type workerReleasePackage struct {
	Name string `json:"name"`
	// URL names this exact build; workers install from it.
	URL string `json:"url"`
	// LatestURL always serves the current build, so a command that names it
	// stays valid across repacks.
	LatestURL string `json:"latestUrl"`
}

// workerRelease tells workers and the web app where this server's worker
// comes from: packages it serves itself, or the npm registry.
type workerRelease struct {
	Source   string                 `json:"source"`
	Version  string                 `json:"version,omitempty"`
	Packages []workerReleasePackage `json:"packages,omitempty"`
}

const (
	workerPackagesPath = "/api/worker/packages/"
	latestPackagesPath = workerPackagesPath + "latest/"
)

// latestFileName is a package's stable file name: @bd777/foundry-worker →
// foundry-worker.tgz.
func latestFileName(name string) string {
	return path.Base(name) + ".tgz"
}

// readWorkerRelease reads the manifest on every call, so repacking the
// directory takes effect without a restart.
func (s *Server) readWorkerRelease() (*workerReleaseManifest, error) {
	if s.options.WorkerPackagesDir == "" {
		return nil, nil
	}
	data, err := os.ReadFile(filepath.Join(s.options.WorkerPackagesDir, "release.json"))
	if err != nil {
		return nil, err
	}
	var manifest workerReleaseManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, err
	}
	if manifest.Version == "" || len(manifest.Packages) == 0 {
		return nil, errors.New("release.json names no version or packages")
	}
	return &manifest, nil
}

func (s *Server) handleWorkerRelease(w http.ResponseWriter, _ *http.Request) {
	manifest, err := s.readWorkerRelease()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "worker packages are configured but unreadable: "+err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	if manifest == nil {
		writeJSON(w, http.StatusOK, workerRelease{Source: "npm"})
		return
	}
	release := workerRelease{Source: "server", Version: manifest.Version}
	for _, pkg := range manifest.Packages {
		release.Packages = append(release.Packages, workerReleasePackage{
			Name:      pkg.Name,
			URL:       workerPackagesPath + url.PathEscape(pkg.File),
			LatestURL: latestPackagesPath + url.PathEscape(latestFileName(pkg.Name)),
		})
	}
	writeJSON(w, http.StatusOK, release)
}

// handleWorkerPackage serves only the tarballs the manifest lists.
func (s *Server) handleWorkerPackage(w http.ResponseWriter, r *http.Request) {
	s.serveWorkerPackage(w, r.PathValue("file"), func(file, _ string) bool { return file == r.PathValue("file") })
}

// handleLatestWorkerPackage serves the current build of a package under its
// stable name.
func (s *Server) handleLatestWorkerPackage(w http.ResponseWriter, r *http.Request) {
	s.serveWorkerPackage(w, r.PathValue("file"), func(_, name string) bool { return latestFileName(name) == r.PathValue("file") })
}

func (s *Server) serveWorkerPackage(w http.ResponseWriter, requested string, matches func(file, name string) bool) {
	manifest, err := s.readWorkerRelease()
	if err != nil || manifest == nil {
		writeError(w, http.StatusNotFound, "this server does not serve worker packages")
		return
	}
	if filepath.Base(requested) != requested {
		writeError(w, http.StatusNotFound, "unknown worker package")
		return
	}
	for _, pkg := range manifest.Packages {
		if filepath.Base(pkg.File) != pkg.File || !matches(pkg.File, pkg.Name) {
			continue
		}
		data, err := fs.ReadFile(os.DirFS(s.options.WorkerPackagesDir), pkg.File)
		if err != nil {
			writeError(w, http.StatusNotFound, "worker package missing on the server")
			return
		}
		w.Header().Set("Content-Type", "application/gzip")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(data)
		return
	}
	writeError(w, http.StatusNotFound, "unknown worker package")
}
