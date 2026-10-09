package skillarchive

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"
	"time"
)

// PackDir zips the folder dir of fsys, SKILL.md at the archive root. Only
// regular files are packed: links and devices are skipped, so a folder cannot
// pull in files from outside itself. Paths are sorted and times fixed, so the
// same folder always yields the same bytes.
func PackDir(fsys fs.FS, dir string) ([]byte, int, error) {
	type file struct{ name, full string }
	var files []file
	total := 0
	err := fs.WalkDir(fsys, dir, func(p string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == ".git" {
				return fs.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		name := strings.TrimPrefix(p, dir+"/")
		if dir == "." {
			name = p
		}
		if !safe(name) {
			return fmt.Errorf("unsafe file path %q", name)
		}
		files = append(files, file{name: name, full: p})
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	sort.Slice(files, func(i, j int) bool { return less(files[i].name, files[j].name) })
	if !hasRootManifest(files, func(f file) string { return f.name }) {
		return nil, 0, fmt.Errorf("%s has no SKILL.md", dir)
	}
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	modified := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, f := range files {
		data, err := fs.ReadFile(fsys, f.full)
		if err != nil {
			return nil, 0, err
		}
		total += len(data)
		if total > MaxArchive {
			return nil, 0, fmt.Errorf("%s is larger than %d MiB", dir, MaxArchive>>20)
		}
		header := &zip.FileHeader{Name: f.name, Method: zip.Deflate, Modified: modified}
		header.SetMode(0o644)
		out, err := writer.CreateHeader(header)
		if err != nil {
			return nil, 0, err
		}
		if _, err := out.Write(data); err != nil {
			return nil, 0, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, 0, err
	}
	return buf.Bytes(), len(files), nil
}

func hasRootManifest[T any](files []T, name func(T) string) bool {
	for _, f := range files {
		if path.Clean(name(f)) == "SKILL.md" {
			return true
		}
	}
	return false
}
