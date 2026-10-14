package feishu

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// MessageFile is a file downloaded from a message, as the session's
// attachments store it.
type MessageFile struct {
	Name     string
	MIMEType string
	Data     []byte
}

// bringFiles downloads the files a message carries through its bot and
// stores them in the workspace's attachments, so the session gets them as
// it gets a person's uploads. It returns the prompt: the message's text,
// plus a line for each file that could not be brought and why.
func (m *WSManager) bringFiles(ctx context.Context, client botClient, workspaceID, messageID string, message incomingMessage) (string, []store.ChatAttachment) {
	var files []MessageFile
	var brought []messageResource
	var missing []string
	for _, resource := range message.resources {
		file, err := client.MessageResource(ctx, messageID, resource.key, resource.resourceType)
		if err != nil {
			log.Printf("[feishu] download %s %s of message %s: %v", resource.resourceType, resource.key, messageID, err)
			missing = append(missing, fmt.Sprintf("(%s could not be downloaded from Feishu: %v)", resource.marker(), err))
			continue
		}
		if resource.name != "" || file.Name == "" {
			file.Name = resource.fileName()
		}
		files = append(files, file)
		brought = append(brought, resource)
	}
	var attachments []store.ChatAttachment
	if len(files) > 0 {
		saved, err := m.dispatcher.SaveAttachments(ctx, workspaceID, files)
		if err != nil {
			log.Printf("[feishu] store the files of message %s in %s: %v", messageID, workspaceID, err)
			for _, resource := range brought {
				missing = append(missing, fmt.Sprintf("(%s could not be stored in the workspace: %v)", resource.marker(), err))
			}
		} else {
			attachments = saved
		}
	}
	return strings.Join(append([]string{message.text}, missing...), "\n"), attachments
}
