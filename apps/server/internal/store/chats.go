package store

import "time"

type ChatAttachment struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Path     string `json:"path"`
	MIMEType string `json:"mimeType"`
	Size     int64  `json:"size"`
	Kind     string `json:"kind"`
}

type ChatThread struct {
	Archived bool `json:"archived,omitempty"`
	ChatArchive
	UpdatedAt          string              `json:"updatedAt,omitempty"`
	ID                 string              `json:"id"`
	WorkspaceID        string              `json:"workspaceId,omitempty"`
	Provider           string              `json:"provider,omitempty"`
	ProfileID          string              `json:"profileId,omitempty"`
	ProfileFingerprint string              `json:"profileFingerprint,omitempty"`
	ProfileLabel       string              `json:"profileLabel,omitempty"`
	NativeSessionID    string              `json:"nativeSessionId,omitempty"`
	Title              string              `json:"title"`
	Preview            string              `json:"preview"`
	HandoffContext     string              `json:"handoffContext,omitempty"`
	Transcript         []TranscriptMessage `json:"transcript,omitempty"`
	// TranscriptBefore is the byte offset in the native log where
	// Transcript starts when it holds only the log's latest part.
	TranscriptBefore int64              `json:"transcriptBefore,omitempty"`
	AnswerRevision   string             `json:"answerRevision,omitempty"`
	RecentMessages   []ChatRecapMessage `json:"recentMessages,omitempty"`
	Status           string             `json:"status,omitempty"`
	Readonly         bool               `json:"readonly"`
}

type ChatRecapMessage struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

type TranscriptMessage struct {
	At     string `json:"at,omitempty"`
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Text   string `json:"text"`
	Title  string `json:"title,omitempty"`
	CallID string `json:"callId,omitempty"`
	Status string `json:"status,omitempty"`
	// Attachments travel with a user message.
	Attachments []ChatAttachment `json:"attachments,omitempty"`
	// RequestUsage is the tokens of the model request that produced this
	// step (Claude).
	RequestUsage *ModelRequestUsage `json:"requestUsage,omitempty"`
	// TurnUsage, on the answer that ended a turn, is the turn's usage read
	// from the agent's own log (imported chats).
	TurnUsage *AgentTurnUsage `json:"turnUsage,omitempty"`
	// Questions an answer asks the person without waiting (Codex
	// request_user_input_async); Delivery is then "async".
	Questions []AgentQuestion `json:"questions,omitempty"`
	Delivery  string          `json:"delivery,omitempty"`
	// Compaction, on a boundary, is the context compaction it marks
	// (DEV-083).
	Compaction *AgentContextCompaction `json:"compaction,omitempty"`
}

// AgentQuestion is one question an Agent asked; without options it takes
// free text only.
type AgentQuestion struct {
	Title   string   `json:"title"`
	Options []string `json:"options,omitempty"`
}

// ModelRequestUsage is one model request's tokens; steps of one request
// share its id and its last report counts.
type ModelRequestUsage struct {
	RequestID        string `json:"requestId"`
	InputTokens      int64  `json:"inputTokens"`
	CacheReadTokens  int64  `json:"cacheReadTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
	OutputTokens     int64  `json:"outputTokens"`
}

type ChatLayoutGroup struct {
	ArchivedAt     string `json:"archivedAt,omitempty"`
	ArchiveBatchID string `json:"archiveBatchId,omitempty"`
	ID             string `json:"id"`
	Name           string `json:"name"`
}

type ChatPlacement struct {
	ChatID  string `json:"chatId"`
	GroupID string `json:"groupId"`
}

type ChatLayout struct {
	Revision  int64             `json:"revision"`
	Groups    []ChatLayoutGroup `json:"groups"`
	Positions []ChatPlacement   `json:"positions"`
}

// Chat queue states: a message waits (queued), is being handed to the
// chat's session (dispatching), went out (sent) or could not (failed; the
// queue waits for the person).
const (
	ChatQueueStateQueued      = "queued"
	ChatQueueStateDispatching = "dispatching"
	ChatQueueStateSent        = "sent"
	ChatQueueStateFailed      = "failed"
)

// ChatQueueRunSettings are the composer's choices when a message was queued;
// the message is sent with them.
type ChatQueueRunSettings struct {
	AgentID               string `json:"agentId,omitempty"`
	Provider              string `json:"provider,omitempty"`
	ProfileID             string `json:"profileId,omitempty"`
	Model                 string `json:"model,omitempty"`
	ClaudeEffort          string `json:"claudeEffort,omitempty"`
	ClaudePermissionMode  string `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort  string `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode      string `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy   string `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed            string `json:"codexSpeed,omitempty"`
	ProfileTransitionNote string `json:"profileTransitionNote,omitempty"`
}

// ChatQueueItem is a message a person queued in a chat. The server sends it
// as the chat's next input once the chat's session is idle; its id becomes
// that input's id.
type ChatQueueItem struct {
	ID            string               `json:"id"`
	ChatID        string               `json:"chatId"`
	Position      int64                `json:"position"`
	Text          string               `json:"text"`
	Attachments   []ChatAttachment     `json:"attachments,omitempty"`
	RunSettings   ChatQueueRunSettings `json:"runSettings"`
	CreatedBy     string               `json:"createdBy,omitempty"`
	CreatedAt     string               `json:"createdAt"`
	UpdatedAt     string               `json:"updatedAt"`
	Revision      int64                `json:"revision"`
	State         string               `json:"state"`
	Error         string               `json:"error,omitempty"`
	SentSessionID string               `json:"sentSessionId,omitempty"`
	// MaybeSent: a failed message its device may have taken after all (it
	// did not answer in time); the person checks the chat before a retry.
	MaybeSent bool `json:"maybeSent,omitempty"`
	// Delivery is when the message enters a running turn (DEV-082):
	// boundary at the turn's next step, interrupt at once, turn_end (or
	// none) as the next turn's input. The server holds every one until
	// then, so the person can still change or withdraw it.
	Delivery string `json:"delivery,omitempty"`
	// DeliverySince is when the person chose that delivery; FallbackAt,
	// for a boundary message, when it goes in without waiting for a step.
	DeliverySince string `json:"deliverySince,omitempty"`
	FallbackAt    string `json:"fallbackAt,omitempty"`
}

// ChatBoundaryLimit is how long a boundary message waits for the running
// turn's next step before it goes in anyway, as for agents (DEV-057).
const ChatBoundaryLimit = 15 * time.Minute

// ChatQueueDelivery is the delivery a queue keeps for delivery: "" for a
// message that waits for the turn to end.
func ChatQueueDelivery(delivery string) (string, bool) {
	switch delivery {
	case "", DeliveryTurnEnd:
		return "", true
	case DeliveryBoundary, DeliveryInterrupt:
		return delivery, true
	}
	return "", false
}

// ChatQueue lists a chat's unsent messages in sending order. Revision grows
// with every change to the queue, including sends.
type ChatQueue struct {
	WorkspaceID string          `json:"workspaceId"`
	ChatID      string          `json:"chatId"`
	Revision    int64           `json:"revision"`
	Items       []ChatQueueItem `json:"items"`
}

type EnqueueChatMessageInput struct {
	Text        string               `json:"text"`
	Attachments []ChatAttachment     `json:"attachments,omitempty"`
	RunSettings ChatQueueRunSettings `json:"runSettings"`
	// Steer moves the message into the chat's running turn at once (an
	// answer to the Agent's question); with nothing running it waits as
	// any queued message does.
	Steer bool `json:"steer,omitempty"`
	// Delivery: when the message enters a running turn (ChatQueueItem).
	Delivery string `json:"delivery,omitempty"`
}

// EditChatQueueItemInput changes the fields it carries; ExpectedRevision is
// the message's revision the edit was made on.
type EditChatQueueItemInput struct {
	Text             *string               `json:"text,omitempty"`
	Attachments      *[]ChatAttachment     `json:"attachments,omitempty"`
	RunSettings      *ChatQueueRunSettings `json:"runSettings,omitempty"`
	Delivery         *string               `json:"delivery,omitempty"`
	ExpectedRevision *int64                `json:"expectedRevision"`
}

// ReorderChatQueueInput names every queued or failed message in the new
// order; ExpectedRevision is the queue's revision the order was made on.
type ReorderChatQueueInput struct {
	ItemIDs          []string `json:"itemIds"`
	ExpectedRevision *int64   `json:"expectedRevision"`
}

type SaveChatLayoutInput struct {
	WorkspaceID      string     `json:"workspaceId"`
	ExpectedRevision *int64     `json:"expectedRevision"`
	Layout           ChatLayout `json:"layout"`
}

type DeleteChatGroupInput struct {
	WorkspaceID      string `json:"workspaceId"`
	GroupID          string `json:"groupId"`
	ExpectedRevision *int64 `json:"expectedRevision"`
}

type ChatTitle struct {
	ChatID              string `json:"chatId"`
	Title               string `json:"title"`
	Version             string `json:"version"`
	GenerationSessionID string `json:"generationSessionId,omitempty"`
	GenerationStatus    string `json:"generationStatus,omitempty"`
	GenerationError     string `json:"generationError,omitempty"`
}

type RenameChatInput struct {
	WorkspaceID     string  `json:"workspaceId"`
	Title           string  `json:"title"`
	ExpectedVersion *string `json:"expectedVersion,omitempty"`
}

type SyncChatsInput struct {
	WorkspaceID string       `json:"workspaceId"`
	Chats       []ChatThread `json:"chats"`
}
