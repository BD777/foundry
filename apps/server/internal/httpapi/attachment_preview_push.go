package httpapi

import (
	"compress/gzip"
	"encoding/base64"
	"io"
	"net/http"
	"path/filepath"
	"strings"
)

// The credential proves which device produced the validated attachment. A
// device can warm only its own workspace cache, never another device's alias.
func (s *Server) handlePushAttachmentPreview(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 128*1024)
	var reader io.Reader = r.Body
	if r.Header.Get("Content-Encoding") == "gzip" {
		gz, err := gzip.NewReader(reader)
		if err != nil {
			writeError(w, 400, "invalid preview")
			return
		}
		defer gz.Close()
		reader = gz
	}
	var input struct {
		WorkspaceID string `json:"workspaceId"`
		Path        string `json:"path"`
		RealPath    string `json:"realPath"`
		Revision    string `json:"revision"`
		Variant     string `json:"variant"`
		MIMEType    string `json:"mimeType"`
		DataBase64  string `json:"dataBase64"`
	}
	if err := decodeStrictJSON(io.LimitReader(reader, 128*1024+1), &input); err != nil {
		writeError(w, 400, "invalid preview")
		return
	}
	if !s.requireDeviceWorkspace(w, r, input.WorkspaceID) {
		return
	}
	workspace, err := s.store.GetWorkspace(r.Context(), input.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	budget := 40 * 1024
	if input.Variant == "placeholder" {
		budget = 2048
	} else if input.Variant != "preview" {
		writeError(w, 400, "invalid preview variant")
		return
	}
	data, err := base64.StdEncoding.DecodeString(input.DataBase64)
	if err != nil || len(data) == 0 || len(data) > budget || len(input.Path) > 4096 || len(input.RealPath) > 4096 || strings.ContainsRune(input.Path, 0) || strings.ContainsRune(input.RealPath, 0) || !filepath.IsAbs(input.Path) || filepath.Clean(input.Path) != input.Path || !pathWithinRoot(filepath.Join(workspace.LocalPath, ".foundry", "attachments"), input.Path) || !filepath.IsAbs(input.RealPath) || filepath.Clean(input.RealPath) != input.RealPath || input.Revision == "" || len(input.Revision) > 256 || !strings.HasPrefix(input.MIMEType, "image/") || http.DetectContentType(data) != input.MIMEType {
		writeError(w, 400, "invalid attachment preview")
		return
	}
	s.attachmentImages.put(attachmentImageAlias(workspace, input.Path, input.Variant), workspace.DeviceID, &cachedAttachmentImage{data: data, mime: input.MIMEType, realPath: input.RealPath, revision: input.Revision})
	w.WriteHeader(http.StatusNoContent)
}
