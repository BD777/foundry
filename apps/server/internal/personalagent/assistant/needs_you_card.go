package assistant

import (
	"context"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The Foundry object ids a chat title may carry when the person pasted
// them into its first message; a needs-you row never shows them. As in
// apps/web/src/lib/foundry-ids.ts, an id is not part of a longer word,
// path or address.
var needsYouIDPattern = regexp.MustCompile(`sess_\d+|iss_\d+|pnd_[\w-]+|(?:dev|ws)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|native_(?:claude|codex)_[A-Za-z0-9][\w.-]*[A-Za-z0-9]`)

// withoutIDs is text without the Foundry ids in it, its spaces collapsed.
func withoutIDs(text string) string {
	var kept strings.Builder
	last := 0
	for _, span := range needsYouIDPattern.FindAllStringIndex(text, -1) {
		before, _ := utf8.DecodeLastRuneInString(text[:span[0]])
		after, _ := utf8.DecodeRuneInString(text[span[1]:])
		if span[0] > 0 && (isASCIIWord(before) || strings.ContainsRune("/.@#=-", before)) ||
			span[1] < len(text) && (isASCIIWord(after) || after == '-') {
			continue
		}
		kept.WriteString(text[last:span[0]])
		kept.WriteString(" ")
		last = span[1]
	}
	kept.WriteString(text[last:])
	return strings.Join(strings.Fields(kept.String()), " ")
}

func isASCIIWord(r rune) bool {
	return r == '_' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z'
}

// needsYouRow is one row of the assistant's home card: the item as the
// needs-you page reads it, and where it came from in words the person
// knows (a chat, a helper, a message channel's conversation), never ids.
func (s *Service) needsYouRow(ctx context.Context, item store.PendingItem) store.PersonalAgentNeedsYouItem {
	return store.PersonalAgentNeedsYouItem{PendingItem: item, From: s.needsYouFrom(ctx, item)}
}

func (s *Service) needsYouFrom(ctx context.Context, item store.PendingItem) store.PersonalAgentNeedsYouFrom {
	workspaceName := ""
	if item.WorkspaceID != "" {
		if workspace, err := s.store.GetWorkspace(ctx, item.WorkspaceID); err == nil {
			workspaceName = workspace.Name
		}
	}
	switch item.Source {
	case store.PendingSourceAccount, store.PendingSourceConnector, store.PendingSourceBundleUpdate, store.PendingSourceMessageChannel:
		return store.PersonalAgentNeedsYouFrom{Kind: store.NeedsYouFromPersonal, Name: item.Rule}
	}
	if item.IssueID != "" {
		return store.PersonalAgentNeedsYouFrom{Kind: store.NeedsYouFromIssue, Name: workspaceName}
	}
	if item.SessionID == "" {
		return store.PersonalAgentNeedsYouFrom{Kind: store.NeedsYouFromProject, Name: workspaceName}
	}
	session, err := s.store.GetAgentSessionSummary(ctx, item.SessionID)
	if err != nil {
		return store.PersonalAgentNeedsYouFrom{Kind: store.NeedsYouFromProject, Name: workspaceName}
	}
	if from, ok := s.channelFrom(ctx, session.ID); ok {
		return from
	}
	if agent, ok := s.Conversation(ctx, session); ok {
		return store.PersonalAgentNeedsYouFrom{Kind: store.NeedsYouFromAssistant, Name: agent.Name}
	}
	title := withoutIDs(firstLineOf(session.Title))
	if _, ok := s.HelperOf(ctx, session); ok {
		return store.PersonalAgentNeedsYouFrom{Kind: store.NeedsYouFromHelper, Name: title, Detail: workspaceName}
	}
	return store.PersonalAgentNeedsYouFrom{Kind: store.NeedsYouFromChat, Name: title, Detail: workspaceName}
}

// channelFrom names a message channel's session by its channel and the
// conversation its messages came from (DEV-203).
func (s *Service) channelFrom(ctx context.Context, sessionID string) (store.PersonalAgentNeedsYouFrom, bool) {
	if s.messageChannels == nil {
		return store.PersonalAgentNeedsYouFrom{}, false
	}
	channel, err := s.messageChannels.MessageChannelOfSession(ctx, sessionID)
	if err != nil {
		return store.PersonalAgentNeedsYouFrom{}, false
	}
	from := store.PersonalAgentNeedsYouFrom{Kind: store.NeedsYouFromChannel, Name: channel.Name}
	records, err := s.messageChannels.ListMessageChannelDeliveries(ctx, channel.ID, nil, 200)
	if err != nil {
		return from, true
	}
	for _, record := range records {
		if record.SessionID != sessionID {
			continue
		}
		conversation := record.Envelope.Conversation
		from.Detail = conversation.Name
		if conversation.Kind == "direct" || from.Detail == "" {
			if sender := record.Envelope.Sender; !sender.IsSelf && sender.Name != "" {
				from.Detail = sender.Name
			}
		}
		if from.Detail != "" {
			break
		}
	}
	return from, true
}
