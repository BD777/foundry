package store

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

var ErrChatLayoutConflict = errors.New("chat layout changed in another client")
var ErrInvalidChatLayout = errors.New("invalid chat layout")
var ErrChatDeletionBusy = errors.New("目录内有正在运行或排队的 Session，请先停止后再删除。")

func ValidateChatLayout(input SaveChatLayoutInput) error {
	invalid := func(message string) error { return fmt.Errorf("%w: %s", ErrInvalidChatLayout, message) }
	if strings.TrimSpace(input.WorkspaceID) == "" || input.ExpectedRevision == nil || *input.ExpectedRevision < 0 {
		return invalid("workspaceId and a non-negative expectedRevision are required")
	}
	if input.Layout.Groups == nil || input.Layout.Positions == nil || len(input.Layout.Groups) > 1000 || len(input.Layout.Positions) > 20000 {
		return invalid("groups and positions must be arrays within the layout limits")
	}
	groups := map[string]bool{"": true}
	for _, group := range input.Layout.Groups {
		if strings.TrimSpace(group.ID) == "" || len(group.ID) > 200 || groups[group.ID] || strings.TrimSpace(group.Name) == "" || utf8.RuneCountInString(group.Name) > 120 {
			return invalid("group IDs must be unique and names must contain 1–120 characters")
		}
		groups[group.ID] = true
	}
	chats := map[string]bool{}
	for _, position := range input.Layout.Positions {
		if strings.TrimSpace(position.ChatID) == "" || len(position.ChatID) > 500 || chats[position.ChatID] || !groups[position.GroupID] {
			return invalid("chat IDs must be unique and reference an existing group")
		}
		chats[position.ChatID] = true
	}
	return nil
}
