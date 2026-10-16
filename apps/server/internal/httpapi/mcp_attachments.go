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
//
// The files one call hands over share a folder and keep their names
// (.foundry/attachments/<date>/<batch>/calc.py), so files sent together
// can still import or include each other. They stay unpublished part files
// until the session or message they come with is accepted; a refused one
// leaves nothing behind.

const (
	maxMCPAttachments     = 10
	maxMCPAttachmentBytes = 25 << 20
)

// handedOver is one call's files, written to the receiving workspace's
// device and not yet published there.
type handedOver struct {
	workspace   store.WorkspaceProjection
	attachments []store.ChatAttachment
	paths       []string // relative to the workspace's attachments
	published   bool
}

// list is what the session's input carries.
func (h *handedOver) list() []store.ChatAttachment {
	if h == nil {
		return nil
	}
	return h.attachments
}

// publish makes the files readable once their session or message is
// accepted, before its device hears of it.
func (s *Server) publishHandedOver(h *handedOver) func(context.Context) error {
	if h == nil {
		return nil
	}
	return func(ctx context.Context) error {
		for index, path := range h.paths {
			if err := s.publishAttachment(ctx, h.workspace, path, h.attachments[index].Size); err != nil {
				return fmt.Errorf("could not deliver %s: %w", h.attachments[index].Name, err)
			}
		}
		h.published = true
		return nil
	}
}

// discardHandedOver drops files whose session or message was refused; once
// published they are the session's and stay.
func (s *Server) discardHandedOver(ctx context.Context, h *handedOver) {
	if h == nil || h.published {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), deviceFileRequestTimeout)
	defer cancel()
	for _, path := range h.paths {
		s.hub.AbortAttachmentUpload(ctx, h.workspace, path)
	}
}

// deliveredAttachment is where a handed-over file landed, as the tool
// result reports it.
type deliveredAttachment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

// mcpSessionWithAttachments is a session a tool started or messaged, with
// the paths of the files that call handed over and whether it waits for
// its offline device (mcpSessionAnswer).
type mcpSessionWithAttachments struct {
	store.AgentSession
	DeliveredAttachments []deliveredAttachment `json:"deliveredAttachments,omitempty"`
	WaitingForDevice     string                `json:"waitingForDevice,omitempty"`
}

func withDeliveredAttachments(session store.AgentSession, attachments []store.ChatAttachment) any {
	if len(attachments) == 0 {
		return session
	}
	delivered := make([]deliveredAttachment, 0, len(attachments))
	for _, attachment := range attachments {
		delivered = append(delivered, deliveredAttachment{attachment.ID, attachment.Name, attachment.Path})
	}
	return mcpSessionWithAttachments{AgentSession: session, DeliveredAttachments: delivered}
}

// mcpAttachments writes the files refs name into one new folder of the
// target workspace's attachments, unpublished (handedOver). A ref is a path
// in the caller's workspace (absolute, or relative to it) or the id of an
// attachment the caller's session was given. A file that cannot be handed
// over drops those already written.
func (s *Server) mcpAttachments(ctx context.Context, actor Actor, targetWorkspaceID string, refs []string) (*handedOver, error) {
	if len(refs) == 0 {
		return nil, nil
	}
	if !actor.Agent() {
		return nil, &statusError{http.StatusBadRequest, errors.New("attachments hand over files of the calling session's workspace: they need a session token")}
	}
	if len(refs) > maxMCPAttachments {
		return nil, &statusError{http.StatusBadRequest, fmt.Errorf("at most %d attachments per message", maxMCPAttachments)}
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
	batchID := attachmentBatchID(now)
	folder := now.Format("20060102") + "/" + batchID + "/"
	batch := &handedOver{workspace: target}
	names := map[string]bool{}
	for index, ref := range refs {
		path, name := ref, filepath.Base(ref)
		if attachment, ok := given[ref]; ok {
			path, name = attachment.Path, attachment.Name
		} else if strings.HasPrefix(ref, "att_") {
			s.discardHandedOver(ctx, batch)
			return nil, &statusError{http.StatusNotFound, errors.New("no attachment " + ref + " among those your session was given")}
		} else if !filepath.IsAbs(path) {
			path = filepath.Join(source.LocalPath, path)
		}
		attachment, relativePath, err := s.copyAttachment(ctx, source, target, filepath.Clean(path), name, folder, attachmentID(batchID, index), names)
		if err != nil {
			s.discardHandedOver(ctx, batch)
			return nil, err
		}
		batch.attachments = append(batch.attachments, attachment)
		batch.paths = append(batch.paths, relativePath)
	}
	return batch, nil
}

// uniqueAttachmentName keeps each name of one folder distinct (ignoring
// case, as some file systems do): a second calc.py arrives as calc-2.py.
func uniqueAttachmentName(name string, taken map[string]bool) string {
	extension := filepath.Ext(name)
	stem := strings.TrimSuffix(name, extension)
	candidate := name
	for n := 2; taken[strings.ToLower(candidate)]; n++ {
		candidate = fmt.Sprintf("%s-%d%s", stem, n, extension)
	}
	taken[strings.ToLower(candidate)] = true
	return candidate
}

// requireAttachmentDevice: the caller's device must be online and read
// workspace files for attachments.
func (s *Server) requireAttachmentDevice(source store.WorkspaceProjection) error {
	device := cmp.Or(strings.TrimSpace(source.DeviceLabel), "your session's device")
	connection := s.hub.connectionFor(source.DeviceID)
	if connection == nil {
		return &statusError{http.StatusConflict, errors.New(device + " is offline, so its files cannot be handed over")}
	}
	if !connection.hasCapability(store.DaemonCapabilityAttachmentFiles) {
		return &statusError{http.StatusConflict, errors.New(device + " runs an older worker, which cannot hand files over; update its worker from its device page in Foundry")}
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

// copyAttachment streams one file from the source device into folder of
// the target workspace's attachments, under its own name, unpublished.
func (s *Server) copyAttachment(ctx context.Context, source, target store.WorkspaceProjection, path, name, folder, id string, names map[string]bool) (store.ChatAttachment, string, error) {
	read := func(offset int64) (attachmentChunk, error) {
		chunk, err := s.hub.ReadWorkspaceFileChunk(ctx, source, path, offset, maxMCPAttachmentBytes)
		if err != nil {
			return chunk, attachmentSourceError(path, err)
		}
		return chunk, nil
	}
	first, err := read(0)
	if err != nil {
		return store.ChatAttachment{}, "", err
	}
	mimeType := first.MIMEType
	if mimeType == "" {
		mimeType = mime.TypeByExtension(strings.ToLower(filepath.Ext(sanitizeAttachmentName(name))))
	}
	name, mimeType = attachmentFileName(name, mimeType)
	name = uniqueAttachmentName(name, names)
	relativePath := folder + name
	pending := &first
	offset := int64(0)
	devicePath, err := s.writeAttachment(ctx, target, relativePath, first.Size, func(buffer []byte) (int, error) {
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
			return 0, &statusError{http.StatusConflict, errors.New(path + " changed while it was copied; try again")}
		}
		if len(buffer) > 0 && len(chunk.Data) == 0 {
			return 0, &statusError{http.StatusConflict, errors.New("the device stopped sending " + path)}
		}
		count := copy(buffer, chunk.Data)
		offset += int64(count)
		return count, nil
	}, false)
	if errors.Is(err, ErrLocalDaemonNotConnected) {
		return store.ChatAttachment{}, "", &statusError{http.StatusConflict, errors.New(cmp.Or(strings.TrimSpace(target.DeviceLabel), "the receiving session's device") + " is offline, so the files cannot be delivered")}
	}
	if err != nil {
		return store.ChatAttachment{}, "", err
	}
	return attachmentRecord(id, name, devicePath, mimeType, first.Size), relativePath, nil
}

// attachmentSourceError says why the caller's device did not hand a file
// over.
func attachmentSourceError(path string, err error) error {
	var refusal attachmentRefusal
	switch {
	case errors.As(err, &refusal) && refusal.code == "too_large":
		return &statusError{http.StatusRequestEntityTooLarge, fmt.Errorf("%s is larger than %d MB, the most one attachment may hold", path, maxMCPAttachmentBytes>>20)}
	case errors.As(err, &refusal) && slices.Contains([]string{"not_found", "invalid_path", "unsupported"}, refusal.code):
		return &statusError{http.StatusNotFound, errors.New(path + ": " + refusal.message + " (attachments are files inside your own workspace folder, or ids of attachments your session was given)")}
	case errors.As(err, &refusal):
		return &statusError{http.StatusConflict, errors.New(path + ": " + refusal.message)}
	case errors.Is(err, ErrLocalDaemonNotConnected):
		return &statusError{http.StatusConflict, errors.New("your session's device went offline while " + path + " was read")}
	default:
		return err
	}
}
