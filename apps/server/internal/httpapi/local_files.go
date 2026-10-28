package httpapi

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
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

// A device that stops answering held an image request open for minutes.
// Each chunk's round trip and the whole image have a deadline; a missed
// first one answers 504, a later one ends the short body. Variables so tests
// can shorten them.
var (
	localImageChunkTimeout = 30 * time.Second
	localImageTimeout      = 3 * time.Minute
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

	attachments, err := s.saveAttachments(r.Context(), workspace, files)
	if errors.Is(err, ErrLocalDaemonNotConnected) {
		writeError(w, http.StatusConflict, "the workspace's device is offline")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, attachments)
}

// saveAttachments stores uploads on the workspace's device, where agents
// read them; the server only names them and relays the bytes.
func (s *Server) saveAttachments(ctx context.Context, workspace store.WorkspaceProjection, files []*multipart.FileHeader) ([]store.ChatAttachment, error) {
	now := time.Now().UTC()
	attachments := make([]store.ChatAttachment, 0, len(files))
	for index, header := range files {
		attachment, err := s.saveAttachment(ctx, workspace, now, index, header)
		if err != nil {
			return nil, err
		}
		attachments = append(attachments, attachment)
	}
	return attachments, nil
}

func (s *Server) saveAttachment(ctx context.Context, workspace store.WorkspaceProjection, now time.Time, index int, header *multipart.FileHeader) (store.ChatAttachment, error) {
	src, err := header.Open()
	if err != nil {
		return store.ChatAttachment{}, errors.New("could not read attachment")
	}
	defer src.Close()

	mimeType := header.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = mime.TypeByExtension(strings.ToLower(filepath.Ext(sanitizeAttachmentName(header.Filename))))
	}
	return s.storeAttachment(ctx, workspace, now, index, header.Filename, mimeType, header.Size, func(buffer []byte) (int, error) {
		count, err := io.ReadFull(src, buffer)
		if err != nil && !errors.Is(err, io.EOF) {
			return count, errors.New("could not read attachment")
		}
		return count, nil
	})
}

// storeAttachment writes a file into the workspace's attachments on its
// device, chunk by chunk as read fills them (each up to the bytes still to
// come), and names it as a message carries it.
func (s *Server) storeAttachment(ctx context.Context, workspace store.WorkspaceProjection, now time.Time, index int, filename, mimeType string, size int64, read func(buffer []byte) (int, error)) (store.ChatAttachment, error) {
	name, mimeType := attachmentFileName(filename, mimeType)
	id := attachmentID(attachmentBatchID(now), index)
	devicePath, err := s.writeAttachment(ctx, workspace, now.Format("20060102")+"/"+id+"_"+name, size, read, true)
	if err != nil {
		return store.ChatAttachment{}, err
	}
	return attachmentRecord(id, name, devicePath, mimeType, size), nil
}

// attachmentBatchID names the files the server stores at once; each file's
// id adds its index (attachmentID).
func attachmentBatchID(now time.Time) string {
	return "att_" + strconv.FormatInt(now.UnixNano(), 36)
}

func attachmentID(batchID string, index int) string {
	return batchID + "_" + strconv.FormatInt(int64(index), 36)
}

// attachmentFileName is the name a file is stored under and the type it is
// served as.
func attachmentFileName(filename, mimeType string) (string, string) {
	name := sanitizeAttachmentName(filename)
	if name == "" {
		name = "attachment"
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return ensureAttachmentExtension(name, mimeType), mimeType
}

func attachmentRecord(id, name, devicePath, mimeType string, size int64) store.ChatAttachment {
	kind := "file"
	if strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		kind = "image"
	}
	return store.ChatAttachment{ID: id, Name: name, Path: devicePath, MIMEType: mimeType, Size: size, Kind: kind}
}

// writeAttachment streams a file to relativePath under the workspace's
// attachments and returns its device path. Unpublished, it stays a part
// file nothing reads until publishAttachment, or AbortAttachmentUpload
// drops it.
func (s *Server) writeAttachment(ctx context.Context, workspace store.WorkspaceProjection, relativePath string, size int64, read func(buffer []byte) (int, error), publish bool) (string, error) {
	var devicePath string
	var err error
	buffer := make([]byte, attachmentChunkBytes)
	for offset := int64(0); ; {
		count, readErr := read(buffer[:min(int64(len(buffer)), size-offset)])
		if readErr != nil {
			s.hub.AbortAttachmentUpload(ctx, workspace, relativePath)
			return "", readErr
		}
		last := offset+int64(count) >= size
		devicePath, err = s.hub.WriteAttachmentChunk(ctx, workspace, relativePath, offset, buffer[:count], last && publish)
		if err != nil {
			if !errors.Is(err, ErrLocalDaemonNotConnected) {
				s.hub.AbortAttachmentUpload(ctx, workspace, relativePath)
				err = errors.New("could not save attachment on the workspace's device")
			}
			return "", err
		}
		offset += int64(count)
		if last {
			return devicePath, nil
		}
	}
}

// publishAttachment makes a file writeAttachment left unpublished readable
// at its path: an empty final chunk after its last byte.
func (s *Server) publishAttachment(ctx context.Context, workspace store.WorkspaceProjection, relativePath string, size int64) error {
	_, err := s.hub.WriteAttachmentChunk(ctx, workspace, relativePath, size, nil, true)
	return err
}

func ensureAttachmentExtension(name string, mimeType string) string {
	if filepath.Ext(name) != "" || !strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		return name
	}
	// The table lists .jfif and .jpe before .jpg.
	if strings.EqualFold(mimeType, "image/jpeg") {
		return name + ".jpg"
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

// handleLocalImageFile serves an image attachment by its device path. The
// workspace's device resolves links, checks the path stays within the
// attachments and that the file is an image; the server streams its chunks.
func (s *Server) handleLocalImageFile(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Vary", "Cookie, Authorization")
	w.Header().Set("Cache-Control", "no-store")
	requestedPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if requestedPath == "" || !filepath.IsAbs(requestedPath) || filepath.Clean(requestedPath) != requestedPath {
		writeError(w, http.StatusBadRequest, "absolute image path is required")
		return
	}
	// This authorization always precedes cache lookup and conditional 304.
	workspace, err := s.attachmentWorkspace(r, requestedPath)
	if err != nil {
		writeError(w, http.StatusNotFound, "image not found")
		return
	}
	s.serveAttachmentImage(w, r, workspace, requestedPath)
}

// serveAttachmentImage serves an image under a workspace's attachments the
// caller may read: ?variant=preview|placeholder a bounded derivative, else
// the original; ?refresh=1 reads it again.
func (s *Server) serveAttachmentImage(w http.ResponseWriter, r *http.Request, workspace store.WorkspaceProjection, requestedPath string) {
	variant := r.URL.Query().Get("variant")
	if variant != "preview" && variant != "placeholder" {
		variant = ""
	}
	alias := attachmentImageAlias(workspace, requestedPath, variant)
	if r.URL.Query().Get("refresh") == "1" {
		s.attachmentImages.invalidate(alias)
	}
	if variant == "" {
		s.streamAttachmentOriginal(w, r, workspace, requestedPath, alias)
		return
	}
	image, err := s.attachmentImages.read(r.Context(), alias, workspace.DeviceID, func(ctx context.Context) (*cachedAttachmentImage, error) {
		return s.loadAttachmentImage(ctx, workspace, requestedPath, variant)
	})
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) && r.Context().Err() == nil {
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusGatewayTimeout, "the device did not send the image within "+localImageChunkTimeout.String())
			return
		}
		if errors.Is(err, ErrLocalDaemonNotConnected) || errors.Is(err, errAttachmentReadsBusy) {
			w.Header().Set("Retry-After", "1")
		}
		writeError(w, attachmentReadStatus(err), err.Error())
		return
	}
	if writeAttachmentImageHeaders(w, r, image, len(image.data)) {
		_, _ = w.Write(image.data)
	}

}

// Originals stream as they arrive; only complete, revision-consistent bytes
// enter the cache. Cancellation stops further RPCs rather than prefetching a
// large original after the viewer leaves.
func (s *Server) streamAttachmentOriginal(w http.ResponseWriter, r *http.Request, workspace store.WorkspaceProjection, path, alias string) {
	if image := s.attachmentImages.get(alias); image != nil {
		if writeAttachmentImageHeaders(w, r, image, len(image.data)) {
			_, _ = w.Write(image.data)
		}
		return
	}
	if !s.attachmentImages.beginOriginal() {
		w.Header().Set("Retry-After", "1")
		writeError(w, 503, errAttachmentReadsBusy.Error())
		return
	}
	defer s.attachmentImages.endOriginal()
	ctx, cancel := context.WithTimeout(r.Context(), localImageTimeout)
	defer cancel()
	read := func(ctx context.Context, offset int64) (attachmentChunk, error) {
		chunkCtx, done := context.WithTimeout(ctx, localImageChunkTimeout)
		defer done()
		return s.hub.readAttachmentChunk(chunkCtx, workspace, wsAttachmentReadPayload{WorkspaceID: workspace.ID, Path: path, Offset: offset, MaxBytes: maxLocalImageBytes, ChunkBytes: 4096})
	}
	first, err := read(ctx, 0)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) && r.Context().Err() == nil {
			w.Header().Set("Retry-After", "1")
			writeError(w, 504, "the device did not send the image within "+localImageChunkTimeout.String())
		} else {
			if errors.Is(err, ErrLocalDaemonNotConnected) {
				w.Header().Set("Retry-After", "1")
			}
			writeError(w, attachmentReadStatus(err), err.Error())
		}
		return
	}
	size := first.Size
	step := int64(len(first.Data))
	if size <= 0 || size > maxLocalImageBytes || step <= 0 || step > size || !strings.HasPrefix(first.MIMEType, "image/") {
		writeError(w, 502, errInvalidAttachmentImage.Error())
		return
	}
	image := &cachedAttachmentImage{mime: first.MIMEType, realPath: first.RealPath, revision: first.Revision}
	if image.realPath != "" && image.revision != "" {
		image.etag = fmt.Sprintf("W/\"%x\"", sha256.Sum256([]byte(image.realPath+"\x00"+image.revision)))
	}
	w.Header().Set("X-Accel-Buffering", "no")
	if !writeAttachmentImageHeaders(w, r, image, int(size)) {
		return
	}
	image.data = make([]byte, size)
	consume := func(offset int64, chunk attachmentChunk) error {
		if chunk.Size != size || chunk.MIMEType != image.mime || chunk.RealPath != image.realPath || chunk.Revision != image.revision || len(chunk.Data) != int(min(step, size-offset)) {
			return errInvalidAttachmentImage
		}
		copy(image.data[offset:], chunk.Data)
		if offset+int64(len(chunk.Data)) == size {
			s.attachmentImages.put(alias, workspace.DeviceID, image)
		}
		if _, err := w.Write(chunk.Data); err != nil {
			return err
		}
		if flush, ok := w.(http.Flusher); ok {
			flush.Flush()
		}
		return nil
	}
	if err = consume(0, first); err != nil {
		return
	}
	if err = pipelineFileChunks(ctx, step, step, &size, read, consume); err != nil {
		return
	}
}
func writeAttachmentImageHeaders(w http.ResponseWriter, r *http.Request, image *cachedAttachmentImage, size int) bool {
	w.Header().Set("Cache-Control", "private, max-age=300, must-revalidate")
	if image.etag != "" {
		w.Header().Set("ETag", image.etag)
	}
	w.Header().Set("Content-Type", image.mime)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	for _, tag := range strings.Split(r.Header.Get("If-None-Match"), ",") {
		tag = strings.TrimSpace(tag)
		if tag == "*" || (image.etag != "" && strings.TrimPrefix(tag, "W/") == strings.TrimPrefix(image.etag, "W/")) {
			w.WriteHeader(304)
			return false
		}
	}
	w.Header().Set("Content-Length", strconv.Itoa(size))
	if r.Method == http.MethodHead {
		w.WriteHeader(200)
		return false
	}
	return true
}

func (s *Server) loadAttachmentImage(ctx context.Context, workspace store.WorkspaceProjection, path string, variant string) (*cachedAttachmentImage, error) {
	read := func(ctx context.Context, offset int64) (attachmentChunk, error) {
		chunkCtx, done := context.WithTimeout(ctx, localImageChunkTimeout)
		defer done()
		return s.hub.readAttachmentChunk(chunkCtx, workspace, wsAttachmentReadPayload{WorkspaceID: workspace.ID, Path: path, Offset: offset, MaxBytes: maxLocalImageBytes, Variant: variant})
	}
	var image *cachedAttachmentImage
	size := int64(maxLocalImageBytes)
	consume := func(offset int64, chunk attachmentChunk) error {
		if offset == 0 {
			if chunk.Size <= 0 || chunk.Size > maxLocalImageBytes || !strings.HasPrefix(chunk.MIMEType, "image/") {
				return errInvalidAttachmentImage
			}
			size = chunk.Size
			image = &cachedAttachmentImage{data: make([]byte, size), mime: chunk.MIMEType, realPath: chunk.RealPath, revision: chunk.Revision}
		}
		if chunk.Size != size || chunk.MIMEType != image.mime || chunk.Revision != image.revision || chunk.RealPath != image.realPath || offset+int64(len(chunk.Data)) > size || len(chunk.Data) == 0 {
			return errInvalidAttachmentImage
		}
		copy(image.data[offset:], chunk.Data)
		return nil
	}
	// The negotiated reader has a fixed 64 KiB block size. Start four requests
	// immediately, including offset zero, so a two-block image costs one RTT.
	if connection := s.hub.connectionFor(workspace.DeviceID); connection != nil && connection.hasCapability("attachment_image_v2") && variant == "" {
		err := pipelineFileChunks(ctx, 0, 64*1024, &size, read, func(offset int64, chunk attachmentChunk) error {
			if err := consume(offset, chunk); err != nil {
				return err
			}
			if len(chunk.Data) != int(min(int64(64*1024), size-offset)) {
				return errInvalidAttachmentImage
			}
			return nil
		})
		return image, err
	}
	first, err := read(ctx, 0)
	if err != nil {
		return nil, err
	}
	if err = consume(0, first); err != nil {
		return nil, err
	}
	step := int64(len(first.Data))
	err = pipelineFileChunks(ctx, step, step, &size, read, func(offset int64, chunk attachmentChunk) error {
		if err := consume(offset, chunk); err != nil {
			return err
		}
		if len(chunk.Data) != int(min(step, size-offset)) {
			return errInvalidAttachmentImage
		}
		return nil
	})
	return image, err
}

func attachmentReadStatus(err error) int {
	var refusal attachmentRefusal
	switch {
	case errors.Is(err, errInvalidAttachmentImage), errors.As(err, &refusal) && refusal.code == "changed":
		return http.StatusBadGateway
	case errors.Is(err, errAttachmentReadsBusy):
		return http.StatusServiceUnavailable
	case errors.Is(err, ErrLocalDaemonNotConnected):
		return http.StatusConflict
	case errors.As(err, &refusal) && refusal.code == "too_large":
		return http.StatusRequestEntityTooLarge
	case errors.As(err, &refusal) && refusal.code == "unsupported":
		return http.StatusUnsupportedMediaType
	default:
		return http.StatusNotFound
	}
}

// attachmentWorkspace finds the viewable workspace whose attachments hold
// the path. The check is lexical; the device re-checks after resolving links.
func (s *Server) attachmentWorkspace(r *http.Request, path string) (store.WorkspaceProjection, error) {
	view, err := s.visibilityFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		return store.WorkspaceProjection{}, err
	}
	workspaces := view.workspaces
	if view.scope.all {
		if workspaces, err = s.store.ListWorkspaces(r.Context()); err != nil {
			return store.WorkspaceProjection{}, err
		}
	}
	for _, workspace := range workspaces {
		if workspace.LocalPath != "" && pathWithinRoot(filepath.Join(workspace.LocalPath, ".foundry", "attachments"), path) {
			return workspace, nil
		}
	}
	return store.WorkspaceProjection{}, errAttachmentOutsideWorkspace
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
