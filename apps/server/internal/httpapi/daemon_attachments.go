package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Attachment files live on the workspace's device. The server relays them
// over the daemon channel in chunks below the worker's message limit and
// never reads or writes a workspace path on its own disk.

const attachmentChunkBytes = 1024 * 1024

type wsAttachmentWritePayload struct {
	WorkspaceID  string `json:"workspaceId"`
	RelativePath string `json:"relativePath"`
	Offset       int64  `json:"offset"`
	DataBase64   string `json:"dataBase64,omitempty"`
	Final        bool   `json:"final,omitempty"`
	Abort        bool   `json:"abort,omitempty"`
}

type wsAttachmentWrittenPayload struct {
	Path  string `json:"path,omitempty"`
	Size  int64  `json:"size"`
	Error string `json:"error,omitempty"`
}

type wsAttachmentReadPayload struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
	Offset      int64  `json:"offset"`
	MaxBytes    int64  `json:"maxBytes"`
}

type wsAttachmentChunkReadPayload struct {
	Size       int64  `json:"size"`
	MIMEType   string `json:"mimeType,omitempty"`
	DataBase64 string `json:"dataBase64,omitempty"`
	Error      string `json:"error,omitempty"`
	// Code classifies a refusal: not_found, too_large or unsupported.
	Code string `json:"code,omitempty"`
}

// attachmentRefusal is a device's reasoned refusal to serve an attachment.
type attachmentRefusal struct{ code, message string }

func (e attachmentRefusal) Error() string { return e.message }

// attachmentChunk is one piece of an image read from a device.
type attachmentChunk struct {
	Size     int64
	MIMEType string
	Data     []byte
}

// WriteAttachmentChunk appends a chunk to an upload on the workspace's
// device; the final chunk publishes the file and returns its device path.
func (h *DaemonHub) WriteAttachmentChunk(ctx context.Context, workspace store.WorkspaceProjection, relativePath string, offset int64, data []byte, final bool) (string, error) {
	value, err := h.attachmentWrite(ctx, workspace, wsAttachmentWritePayload{
		WorkspaceID: workspace.ID, RelativePath: relativePath, Offset: offset,
		DataBase64: base64.StdEncoding.EncodeToString(data), Final: final,
	})
	return value.Path, err
}

// AbortAttachmentUpload drops an unfinished upload on the device.
func (h *DaemonHub) AbortAttachmentUpload(ctx context.Context, workspace store.WorkspaceProjection, relativePath string) {
	_, _ = h.attachmentWrite(ctx, workspace, wsAttachmentWritePayload{WorkspaceID: workspace.ID, RelativePath: relativePath, Abort: true})
}

func (h *DaemonHub) attachmentWrite(ctx context.Context, workspace store.WorkspaceProjection, payload wsAttachmentWritePayload) (wsAttachmentWrittenPayload, error) {
	connection := h.connectionFor(workspace.DeviceID)
	if connection == nil {
		return wsAttachmentWrittenPayload{}, ErrLocalDaemonNotConnected
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return wsAttachmentWrittenPayload{}, err
	}
	value, err := daemonRequest[wsAttachmentWrittenPayload](ctx, connection, wsAttachmentWriteType, raw)
	if err == nil && value.Error != "" {
		err = errors.New(value.Error)
	}
	return value, err
}

// ReadAttachmentImageChunk reads one chunk of an image attachment from the
// workspace's device, which validates the path and the image type.
func (h *DaemonHub) ReadAttachmentImageChunk(ctx context.Context, workspace store.WorkspaceProjection, path string, offset int64, maxBytes int64) (attachmentChunk, error) {
	connection := h.connectionFor(workspace.DeviceID)
	if connection == nil {
		return attachmentChunk{}, ErrLocalDaemonNotConnected
	}
	raw, err := json.Marshal(wsAttachmentReadPayload{WorkspaceID: workspace.ID, Path: path, Offset: offset, MaxBytes: maxBytes})
	if err != nil {
		return attachmentChunk{}, err
	}
	value, err := daemonRequest[wsAttachmentChunkReadPayload](ctx, connection, wsAttachmentReadType, raw)
	if err != nil {
		return attachmentChunk{}, err
	}
	if value.Error != "" {
		return attachmentChunk{}, attachmentRefusal{code: value.Code, message: value.Error}
	}
	data, err := base64.StdEncoding.DecodeString(value.DataBase64)
	if err != nil {
		return attachmentChunk{}, err
	}
	return attachmentChunk{Size: value.Size, MIMEType: value.MIMEType, Data: data}, nil
}
