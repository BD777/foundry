package httpapi

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime"
	"path/filepath"
	"strconv"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var _ feishu.PersonalAgentInboxDesk = personalAgentDesk{}

func (d personalAgentDesk) CaptureInbox(ctx context.Context, userID, text string, origin store.PersonalAgentInboxOrigin) (store.PersonalAgentInboxEntry, error) {
	if origin.AppID == "" || origin.ChatID == "" || origin.MessageID == "" || len(origin.Resources) > 32 {
		return store.PersonalAgentInboxEntry{}, invalid("incomplete or oversized channel origin")
	}
	return d.s.captureAssistantInboxOrigin(ctx, userID, "feishu", store.PersonalAgentInboxCapture{
		MessageID: origin.AppID + ":" + origin.MessageID, Text: text,
	}, &origin)
}

// SaveInboxAttachments uses source identity rather than the retry's clock.
// The normal Worker attachment protocol still checks the path, size and
// atomic publication. All writes stay in this input's generated directory.
func (s *Server) SaveInboxAttachments(ctx context.Context, workspaceID, batchID string, files []feishu.MessageFile) ([]store.ChatAttachment, error) {
	total := int64(0)
	for _, file := range files {
		total += int64(len(file.Data))
	}
	if len(files) > 10 || total > maxAttachmentUploadBytes {
		return nil, fmt.Errorf("inbox attachments exceed the upload limit")
	}
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	attachments := []store.ChatAttachment{}
	for index, file := range files {
		mediaType := file.MIMEType
		if mediaType == "" || mediaType == "application/octet-stream" {
			if inferred := mime.TypeByExtension(filepath.Ext(file.Name)); inferred != "" {
				mediaType = inferred
			}
		}
		name, mediaType := attachmentFileName(file.Name, mediaType)
		id := flow.Key("att", workspaceID, batchID, strconv.Itoa(index))
		path := "inbox/" + flow.Key("batch", batchID) + "/" + id + "_" + name
		data := bytes.NewReader(file.Data)
		devicePath, err := s.writeAttachment(ctx, workspace, path, int64(len(file.Data)), func(buffer []byte) (int, error) { return io.ReadFull(data, buffer) }, true)
		if err != nil {
			return nil, err
		}
		attachments = append(attachments, attachmentRecord(id, name, devicePath, mediaType, int64(len(file.Data))))
	}
	return attachments, nil
}
