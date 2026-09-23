package httpapi

import (
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	maxAttachmentUploadBytes = 100 * 1024 * 1024
	maxLocalImageBytes       = 25 * 1024 * 1024
)

var errAttachmentOutsideWorkspace = errors.New("attachment is outside a registered workspace")

func (s *Server) handleUploadAttachments(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAttachmentUploadBytes)
	if err := r.ParseMultipartForm(maxAttachmentUploadBytes); err != nil {
		writeError(w, http.StatusBadRequest, "invalid attachment upload")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}

	workspaceID := strings.TrimSpace(r.FormValue("workspaceId"))
	if !s.requireWorkspace(w, r, workspaceID, store.WorkspaceRoleMember) {
		return
	}
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}
	workspace, err := s.store.GetWorkspace(r.Context(), workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		writeError(w, http.StatusBadRequest, "at least one file is required")
		return
	}

	attachments, err := saveAttachments(workspace, files)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, attachments)
}

func saveAttachments(workspace store.WorkspaceProjection, files []*multipart.FileHeader) ([]store.ChatAttachment, error) {
	now := time.Now().UTC()
	dir := filepath.Join(workspace.LocalPath, ".foundry", "attachments", now.Format("20060102"))
	if err := ensurePrivateDirectory(dir); err != nil {
		return nil, errors.New("could not create attachment directory")
	}

	attachments := make([]store.ChatAttachment, 0, len(files))
	for index, header := range files {
		attachment, err := saveAttachment(dir, now, index, header)
		if err != nil {
			return nil, err
		}
		attachments = append(attachments, attachment)
	}
	return attachments, nil
}

func saveAttachment(dir string, now time.Time, index int, header *multipart.FileHeader) (store.ChatAttachment, error) {
	src, err := header.Open()
	if err != nil {
		return store.ChatAttachment{}, errors.New("could not read attachment")
	}
	defer src.Close()

	name := sanitizeAttachmentName(header.Filename)
	if name == "" {
		name = "attachment"
	}
	mimeType := header.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	name = ensureAttachmentExtension(name, mimeType)
	id := "att_" + strconv.FormatInt(now.UnixNano(), 36) + "_" + strconv.FormatInt(int64(index), 36)
	dstPath := filepath.Join(dir, id+"_"+name)

	size, err := copyAttachmentAtomically(dstPath, src)
	if err != nil {
		return store.ChatAttachment{}, errors.New("could not save attachment")
	}
	kind := "file"
	if strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		kind = "image"
	}
	return store.ChatAttachment{
		ID:       id,
		Name:     name,
		Path:     dstPath,
		MIMEType: mimeType,
		Size:     size,
		Kind:     kind,
	}, nil
}

func copyAttachmentAtomically(dstPath string, src io.Reader) (int64, error) {
	temp, err := os.CreateTemp(filepath.Dir(dstPath), ".attachment-*.tmp")
	if err != nil {
		return 0, err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)

	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return 0, err
	}
	size, copyErr := io.Copy(temp, src)
	syncErr := temp.Sync()
	closeErr := temp.Close()
	if copyErr != nil {
		return 0, copyErr
	}
	if syncErr != nil {
		return 0, syncErr
	}
	if closeErr != nil {
		return 0, closeErr
	}
	if err := os.Rename(tempPath, dstPath); err != nil {
		return 0, err
	}
	return size, os.Chmod(dstPath, 0o600)
}

func ensurePrivateDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return os.Chmod(path, 0o700)
}

func ensureAttachmentExtension(name string, mimeType string) string {
	if filepath.Ext(name) != "" || !strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		return name
	}
	extensions, err := mime.ExtensionsByType(mimeType)
	if err != nil || len(extensions) == 0 {
		return name
	}
	return name + extensions[0]
}

func sanitizeAttachmentName(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	name = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r
		case r >= 'A' && r <= 'Z':
			return r
		case r >= '0' && r <= '9':
			return r
		case r == '.', r == '-', r == '_', r == ' ':
			return r
		default:
			return '_'
		}
	}, name)
	return strings.Trim(name, " .")
}

func (s *Server) handleLocalImageFile(w http.ResponseWriter, r *http.Request) {
	requestedPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if requestedPath == "" || !filepath.IsAbs(requestedPath) {
		writeError(w, http.StatusBadRequest, "absolute image path is required")
		return
	}
	path, err := s.resolveAttachmentPath(r, requestedPath)
	if err != nil {
		writeError(w, http.StatusNotFound, "image not found")
		return
	}

	file, err := os.Open(path)
	if err != nil {
		writeError(w, http.StatusNotFound, "image not found")
		return
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		writeError(w, http.StatusNotFound, "image not found")
		return
	}
	if stat.Size() > maxLocalImageBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "image is too large")
		return
	}
	contentType, err := detectSupportedImageType(file)
	if err != nil {
		writeError(w, http.StatusUnsupportedMediaType, "not a supported image")
		return
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.FormatInt(stat.Size(), 10))
	if _, err := io.Copy(w, file); err != nil {
		return
	}
}

func (s *Server) resolveAttachmentPath(r *http.Request, requestedPath string) (string, error) {
	resolvedTarget, err := filepath.EvalSymlinks(requestedPath)
	if err != nil {
		return "", err
	}
	// Only attachment roots of workspaces the caller may view qualify.
	view, err := s.visibilityFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		return "", err
	}
	workspaces := view.workspaces
	if view.scope.all {
		if workspaces, err = s.store.ListWorkspaces(r.Context()); err != nil {
			return "", err
		}
	}
	for _, workspace := range workspaces {
		root := filepath.Join(workspace.LocalPath, ".foundry", "attachments")
		resolvedRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		if pathWithinRoot(resolvedRoot, resolvedTarget) {
			return resolvedTarget, nil
		}
	}
	return "", errAttachmentOutsideWorkspace
}

func pathWithinRoot(root string, target string) bool {
	relativePath, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return relativePath != "." &&
		relativePath != ".." &&
		!strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) &&
		!filepath.IsAbs(relativePath)
}

func detectSupportedImageType(file *os.File) (string, error) {
	header := make([]byte, 512)
	count, err := file.Read(header)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	contentType := http.DetectContentType(header[:count])
	switch contentType {
	case "image/gif", "image/jpeg", "image/png", "image/webp":
		return contentType, nil
	default:
		return "", errors.New("unsupported image type")
	}
}
