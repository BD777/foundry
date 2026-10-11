package httpapi

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Files one session hands another (create_session and send_message
// attachments) arrive as a person's attachments do: the server reads each
// from the caller's own device, where the path must stay inside the
// caller's workspace folder, and writes it into the attachments of the
// workspace the receiving session runs in, chunk by chunk over the daemon
// channel. A session on another device so receives the files too.

const (
	maxMCPAttachments     = 10
	maxMCPAttachmentBytes = 25 << 20
)

// mcpAttachments copies the files refs name into the target workspace's
// attachments. A ref is a path in the caller's workspace (absolute, or
// relative to it) or the id of an attachment the caller's session was
// given.
func (s *Server) mcpAttachments(ctx context.Context, actor Actor, targetWorkspaceID string, refs []string) ([]store.ChatAttachment, error) {
	if len(refs) == 0 {
		return nil, nil
	}
	if !actor.Agent() {
		return nil, &mcpToolError{http.StatusBadRequest, "attachments hand over files of the calling session's workspace: they need a session token"}
	}
	if len(refs) > maxMCPAttachments {
		return nil, &mcpToolError{http.StatusBadRequest, fmt.Sprintf("at most %d attachments per message", maxMCPAttachments)}
	}
	caller, err := s.store.GetAgentSession(ctx, actor.Identity.SessionID)
	if err != nil {
		return nil, err
	}
	source, err := s.store.GetWorkspace(ctx, caller.WorkspaceID)
	if err != nil {
		return nil, err
	}
	target, err := s.store.GetWorkspace(ctx, targetWorkspaceID)
	if err != nil {
		return nil, err
	}
	if err := s.requireAttachmentDevice(source); err != nil {
		return nil, err
	}
	given := givenAttachments(caller)
	now := time.Now().UTC()
	attachments := make([]store.ChatAttachment, 0, len(refs))
	for index, ref := range refs {
		path, name := ref, filepath.Base(ref)
		if attachment, ok := given[ref]; ok {
			path, name = attachment.Path, attachment.Name
		} else if strings.HasPrefix(ref, "att_") {
			return nil, &mcpToolError{http.StatusNotFound, "no attachment " + ref + " among those your session was given"}
		} else if !filepath.IsAbs(path) {
			path = filepath.Join(source.LocalPath, path)
		}
		attachment, err := s.copyAttachment(ctx, source, target, filepath.Clean(path), name, now, index)
		if err != nil {
			return nil, err
		}
		attachments = append(attachments, attachment)
	}
	return attachments, nil
}

// requireAttachmentDevice: the caller's device must be online and read
// workspace files for attachments.
func (s *Server) requireAttachmentDevice(source store.WorkspaceProjection) error {
	device := cmp.Or(strings.TrimSpace(source.DeviceLabel), "your session's device")
	connection := s.hub.connectionFor(source.DeviceID)
	if connection == nil {
		return &mcpToolError{http.StatusConflict, device + " is offline, so its files cannot be handed over"}
	}
	if !connection.hasCapability(store.DaemonCapabilityAttachmentFiles) {
		return &mcpToolError{http.StatusConflict, device + " runs an older worker, which cannot hand files over; update its worker from its device page in Foundry"}
	}
	return nil
}

// givenAttachments are the attachments that came with the session's
// inputs, by id.
func givenAttachments(session store.AgentSession) map[string]store.ChatAttachment {
	given := map[string]store.ChatAttachment{}
	for _, attachment := range session.Input.Attachments {
		given[attachment.ID] = attachment
	}
	for _, event := range session.Events {
		if event.Message == nil {
			continue
		}
		for _, attachment := range event.Message.Attachments {
			given[attachment.ID] = attachment
		}
	}
	return given
}

// copyAttachment streams one file from the source device into the target
// workspace's attachments.
func (s *Server) copyAttachment(ctx context.Context, source, target store.WorkspaceProjection, path, name string, now time.Time, index int) (store.ChatAttachment, error) {
	read := func(offset int64) (attachmentChunk, error) {
		chunk, err := s.hub.ReadWorkspaceFileChunk(ctx, source, path, offset, maxMCPAttachmentBytes)
		if err != nil {
			return chunk, attachmentSourceError(path, err)
		}
		return chunk, nil
	}
	first, err := read(0)
	if err != nil {
		return store.ChatAttachment{}, err
	}
	mimeType := first.MIMEType
	if mimeType == "" {
		mimeType = mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
	}
	pending := &first
	offset := int64(0)
	attachment, err := s.storeAttachment(ctx, target, now, index, name, mimeType, first.Size, func(buffer []byte) (int, error) {
		chunk := pending
		pending = nil
		if chunk == nil {
			next, err := read(offset)
			if err != nil {
				return 0, err
			}
			chunk = &next
		}
		if chunk.Size != first.Size {
			return 0, &mcpToolError{http.StatusConflict, path + " changed while it was copied; try again"}
		}
		if len(buffer) > 0 && len(chunk.Data) == 0 {
			return 0, &mcpToolError{http.StatusConflict, "the device stopped sending " + path}
		}
		count := copy(buffer, chunk.Data)
		offset += int64(count)
		return count, nil
	})
	if errors.Is(err, ErrLocalDaemonNotConnected) {
		return attachment, &mcpToolError{http.StatusConflict, cmp.Or(strings.TrimSpace(target.DeviceLabel), "the receiving session's device") + " is offline, so the files cannot be delivered"}
	}
	return attachment, err
}

// attachmentSourceError says why the caller's device did not hand a file
// over.
func attachmentSourceError(path string, err error) error {
	var refusal attachmentRefusal
	switch {
	case errors.As(err, &refusal) && refusal.code == "too_large":
		return &mcpToolError{http.StatusRequestEntityTooLarge, fmt.Sprintf("%s is larger than %d MB, the most one attachment may hold", path, maxMCPAttachmentBytes>>20)}
	case errors.As(err, &refusal) && slices.Contains([]string{"not_found", "invalid_path", "unsupported"}, refusal.code):
		return &mcpToolError{http.StatusNotFound, path + ": " + refusal.message + " (attachments are files inside your own workspace folder, or ids of attachments your session was given)"}
	case errors.As(err, &refusal):
		return &mcpToolError{http.StatusConflict, path + ": " + refusal.message}
	case errors.Is(err, ErrLocalDaemonNotConnected):
		return &mcpToolError{http.StatusConflict, "your session's device went offline while " + path + " was read"}
	default:
		return err
	}
}
