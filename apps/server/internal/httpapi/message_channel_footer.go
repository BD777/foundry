package httpapi

import (
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/channels"
	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// messageChannelWriteFooter is the AI footer the gateway appends to a
// message write: only a session that belongs to a channel's assistant on
// this account gets it (the same ownership test as the channel's own
// writes). Any other session of the account — the person's own tools, an
// E2E sender — passes untouched.
func (s *Server) messageChannelWriteFooter(ctx context.Context, accountID, sessionID string) (string, bool) {
	if accountID == "" || sessionID == "" {
		return "", false
	}
	summary, err := s.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil {
		return "", false
	}
	access, err := permission.Resolve(ctx, s.store, summary)
	if err != nil || !access.Applicable || access.Agent.ID == "" {
		return "", false
	}
	st, ok := s.store.(store.MessageChannelStore)
	if !ok {
		return "", false
	}
	records, err := st.ListMessageChannels(ctx, access.Agent.UserID, access.Agent.ID)
	if err != nil {
		return "", false
	}
	for _, record := range records {
		if record.Source.AccountID == accountID {
			return channels.FooterText(record.MessageChannel), true
		}
	}
	return "", false
}
