package store

import (
	"context"
	"errors"
)

var ErrPersonalAgentRevision = errors.New("personal agent record changed; read its current revision")

// PersonalAgentInboxEntry is an authenticated input received independently of
// the assistant's device or model. Text and source identity never change.
// Delivered means its input exists in a session, not that its intent is done.
type PersonalAgentInboxEntry struct {
	ID                  string                    `json:"id"`
	RootID              string                    `json:"rootId"`
	Timezone            string                    `json:"timezone,omitempty"`
	UserID              string                    `json:"-"`
	Origin              *PersonalAgentInboxOrigin `json:"-"`
	Channel             string                    `json:"channel"`
	MessageID           string                    `json:"messageId"`
	Text                string                    `json:"text"`
	Status              string                    `json:"status"`
	Revision            int64                     `json:"revision"`
	InputID             string                    `json:"inputId"`
	SessionID           string                    `json:"sessionId,omitempty"`
	WaitingReason       string                    `json:"waitingReason,omitempty"`
	LeaseUntil          string                    `json:"-"`
	CreatedAt           string                    `json:"createdAt"`
	UpdatedAt           string                    `json:"updatedAt"`
	ResultStatus        string                    `json:"resultStatus,omitempty"`
	ResultText          string                    `json:"resultText,omitempty"`
	ResultError         string                    `json:"resultError,omitempty"`
	ResultTruncated     bool                      `json:"resultTruncated,omitempty"`
	NotificationPending bool                      `json:"-"`
}

// Channel routing and resource references are server-owned provenance, never
// parameters accepted from the Web or a model. No attachment bytes or secrets.
type PersonalAgentInboxOrigin struct {
	AppID           string                       `json:"appId"`
	ChatID          string                       `json:"chatId"`
	MessageID       string                       `json:"messageId"`
	RootMessageID   string                       `json:"rootMessageId,omitempty"`
	ThreadSessionID string                       `json:"threadSessionId,omitempty"`
	Resources       []PersonalAgentInboxResource `json:"resources,omitempty"`
}

type PersonalAgentInboxResource struct {
	Key   string `json:"key"`
	Type  string `json:"type"`
	Name  string `json:"name,omitempty"`
	Label string `json:"label,omitempty"`
}

type PersonalAgentInboxCapture struct {
	MessageID string `json:"messageId"`
	Text      string `json:"text"`
}

type PersonalAgentInboxAction struct {
	Action    string `json:"action"`
	Revision  int64  `json:"revision"`
	RequestID string `json:"requestId"`
}

// PersonalAgentInboxStore is a module-scoped contract; it does not enlarge the
// core Store interface. A capture and all subsequent updates are durable.
type PersonalAgentInboxStore interface {
	CapturePersonalAgentInbox(context.Context, PersonalAgentInboxEntry) (PersonalAgentInboxEntry, error)
	GetPersonalAgentInbox(context.Context, string, string) (PersonalAgentInboxEntry, error)
	ListPersonalAgentInbox(context.Context, string, int) ([]PersonalAgentInboxEntry, error)
	DuePersonalAgentInbox(context.Context, string, int) ([]PersonalAgentInboxEntry, error)
	SavePersonalAgentInbox(context.Context, PersonalAgentInboxEntry) (PersonalAgentInboxEntry, error)
	PersonalAgentInboxSession(context.Context, string, string) (string, error)
	PersonalAgentInboxByInput(context.Context, string, string) (PersonalAgentInboxEntry, error)
	PendingPersonalAgentInboxNotifications(context.Context, string, int) ([]PersonalAgentInboxEntry, error)
	UnresolvedPersonalAgentInboxResults(context.Context, int) ([]PersonalAgentInboxEntry, error)
	RetryPersonalAgentInbox(context.Context, string, string, int64, PersonalAgentInboxEntry) (PersonalAgentInboxEntry, error)
}
