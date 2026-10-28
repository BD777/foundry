package httpapi

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const fileDownloadCapability = "file_download_v1"
const fileDownloadChunkBytes = 64 * 1024
const maxFileDownloadBytes = 100 * 1024 * 1024

var fileDownloadChunkTimeout = 30 * time.Second
var fileDownloadTimeout = 10 * time.Minute

type wsFileDownloadRequest struct {
	Offset   int64  `json:"offset"`
	Revision string `json:"revision,omitempty"`
}
type wsFileDownloadChunk struct {
	Offset     int64  `json:"offset"`
	Size       int64  `json:"size"`
	Revision   string `json:"revision"`
	DataBase64 string `json:"dataBase64"`
}
type fileDownloadRefusal struct{ code, message string }

func (e fileDownloadRefusal) Error() string { return e.message }

// A workspace file answer's error is the device refusing the path (missing,
// outside the workspace, not a file, Git internals): not found, as for a
// session file, so a path an answer named reads as gone, not as a fault.
func (p wsFileReadPayload) refusal() error {
	if p.DownloadCode != "" {
		return fileDownloadRefusal{p.DownloadCode, p.Error}
	}
	return sessionFileRefused(p.Error)
}

func (s *Server) handleDownloadSessionFile(w http.ResponseWriter, r *http.Request) {
	session := guardedSession(r)
	workspace, err := s.store.GetWorkspace(r.Context(), session.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	s.downloadDeviceFile(w, r, workspace.DeviceID, fileDownloadCapability, func(ctx context.Context, c *daemonConnection, path string, request wsFileDownloadRequest) (*wsFileDownloadChunk, error) {
		value, err := callDevice[wsSessionFileReadPayload](ctx, c, wsReadSessionFileType, wsReadSessionFilePayload{WorkspaceID: workspace.ID, SessionID: session.ID, Path: path, Download: &request})
		if err != nil {
			return nil, err
		}
		if request.Offset == 0 && !sessionFileReadableByViewer(value.SessionFileRead) && !s.requireWorkspace(w, r, session.WorkspaceID, store.WorkspaceRoleMember) {
			return nil, errDownloadForbidden
		}
		return value.DownloadChunk, nil
	})
}

func (s *Server) handleDownloadWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	workspace, err := s.store.GetWorkspace(r.Context(), strings.TrimSpace(r.URL.Query().Get("workspaceId")))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	s.downloadDeviceFile(w, r, workspace.DeviceID, fileDownloadCapability, func(ctx context.Context, c *daemonConnection, path string, request wsFileDownloadRequest) (*wsFileDownloadChunk, error) {
		value, err := callDevice[wsFileReadPayload](ctx, c, wsReadFileType, wsReadFilePayload{WorkspaceID: workspace.ID, Path: path, Download: &request})
		return value.DownloadChunk, err
	})
}

// The file's existing reader enforces ledger/path policy on every chunk. The
// revision prevents silently combining bytes from different file versions.
var errDownloadForbidden = errors.New("file download forbidden")

type fileChunkReader func(context.Context, *daemonConnection, string, wsFileDownloadRequest) (*wsFileDownloadChunk, error)

func (s *Server) downloadDeviceFile(w http.ResponseWriter, r *http.Request, deviceID, capability string, read fileChunkReader) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path == "" {
		writeError(w, http.StatusBadRequest, "file path is required")
		return
	}
	connection := s.hub.connectionFor(deviceID)
	if connection == nil {
		writeDownloadError(w, ErrLocalDaemonNotConnected)
		return
	}
	if !connection.hasCapability(capability) {
		writeJSON(w, http.StatusConflict, map[string]string{"code": "worker_update_required", "error": "Update the device worker to download complete files."})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), fileDownloadTimeout)
	defer cancel()
	readChunk := func(parent context.Context, offset int64, revision string) (*wsFileDownloadChunk, []byte, error) {
		chunkCtx, done := context.WithTimeout(parent, fileDownloadChunkTimeout)
		defer done()
		chunk, err := read(chunkCtx, connection, path, wsFileDownloadRequest{Offset: offset, Revision: revision})
		if err != nil {
			return nil, nil, err
		}
		if chunk == nil || chunk.Offset != offset || chunk.Size < 0 || chunk.Size > maxFileDownloadBytes || chunk.Revision == "" || (revision != "" && revision != chunk.Revision) {
			return nil, nil, fmt.Errorf("invalid file chunk from device")
		}
		data, err := base64.StdEncoding.DecodeString(chunk.DataBase64)
		if err != nil || len(data) > fileDownloadChunkBytes || offset+int64(len(data)) > chunk.Size || (len(data) == 0 && offset < chunk.Size) {
			return nil, nil, fmt.Errorf("invalid file bytes from device")
		}
		return chunk, data, nil
	}
	chunk, data, err := readChunk(ctx, 0, "")
	if err != nil {
		if !errors.Is(err, errDownloadForbidden) {
			writeDownloadError(w, err)
		}
		return
	}
	size, revision := chunk.Size, chunk.Revision
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(path)}))
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if _, err = w.Write(data); err != nil {
		return
	}
	offset := int64(len(data))
	if offset >= size {
		return
	}
	_ = pipelineFileChunks(ctx, offset, fileDownloadChunkBytes, &size, func(partCtx context.Context, offset int64) ([]byte, error) {
		chunk, data, err := readChunk(partCtx, offset, revision)
		if err != nil {
			return nil, err
		}
		if chunk.Size != size || len(data) != int(min(int64(fileDownloadChunkBytes), size-offset)) {
			return nil, errors.New("file changed or incomplete chunk")
		}
		return data, nil
	}, func(_ int64, data []byte) error { _, err := w.Write(data); return err }) // a failed stream ends short; the browser retries the whole read

}
func writeDownloadError(w http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	code := "file_unavailable"
	var refusal fileDownloadRefusal
	var sessionRefusal sessionFileRefusal
	switch {
	case errors.Is(err, ErrLocalDaemonNotConnected), errors.Is(err, store.ErrNotFound):
		status = http.StatusConflict
		code = "device_offline"
	case errors.Is(err, context.DeadlineExceeded):
		status = http.StatusGatewayTimeout
		code = "device_slow"
	case errors.As(err, &refusal):
		switch refusal.code {
		case "too_large":
			status = http.StatusRequestEntityTooLarge
			code = "file_too_large"
		case "changed":
			status = http.StatusConflict
			code = "file_changed"
		case "invalid_offset":
			status = http.StatusBadRequest
		case "sensitive":
			status = http.StatusForbidden
			code = "file_sensitive"
		default:
			status = http.StatusNotFound
			code = "file_missing"
		}
	case errors.As(err, &sessionRefusal):
		status = http.StatusNotFound
		code = "file_missing"
	}
	if status == http.StatusConflict || status == http.StatusGatewayTimeout {
		w.Header().Set("Retry-After", "1")
	}
	writeJSON(w, status, map[string]string{"code": code, "error": err.Error()})
}
