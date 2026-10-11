package httpapi

import (
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"
)

// serveWeb serves the built React/Vite web application from distDir.
//
// It is only mounted when ServerOptions.WebDistDir is set (the container
// deployment); development keeps using the Vite dev server on its own port.
//
// Unknown non-asset paths fall back to index.html so client-side routes
// survive a hard reload. Requests under /assets/ that do not match a real
// hashed file return 404 instead of the HTML fallback. Unmatched /api/
// paths return the standard JSON error rather than index.html.
//
// Hashed assets never change and are cached for good; everything else
// (index.html, version.json) is revalidated on every load, so a page that
// reloads gets the build deployed now (see apps/web/src/lib/web-build.ts).
func (s *Server) serveWeb(distDir string) http.Handler {
	webFS := os.DirFS(distDir)
	fileServer := http.FileServer(http.FS(webFS))

	serveIndex := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFileFS(w, r, webFS, "index.html")
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		urlPath := r.URL.Path

		if strings.HasPrefix(urlPath, "/api/") {
			writeError(w, http.StatusNotFound, "not found")
			return
		}

		rel := strings.TrimPrefix(path.Clean("/"+urlPath), "/")
		if rel == "" {
			serveIndex(w, r)
			return
		}

		info, err := fs.Stat(webFS, rel)
		if err == nil && !info.IsDir() {
			if strings.HasPrefix(urlPath, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			fileServer.ServeHTTP(w, r)
			return
		}

		if strings.HasPrefix(urlPath, "/assets/") {
			http.NotFound(w, r)
			return
		}

		serveIndex(w, r)
	})
}
