package store

import "context"

// ChatDigest is what a server holds of a device's native chat, enough for a
// worker that lost its own upload record (or never had one) to tell which
// chats it need not send again: the fields that change whenever the chat's
// content does, and how many transcript messages are stored.
type ChatDigest struct {
	ID                 string `json:"id"`
	UpdatedAt          string `json:"updatedAt,omitempty"`
	Status             string `json:"status,omitempty"`
	AnswerRevision     string `json:"answerRevision,omitempty"`
	Title              string `json:"title"`
	Preview            string `json:"preview"`
	TranscriptMessages int    `json:"transcriptMessages"`
}

// ChatDigestStore lists the digests of a workspace's native chats.
type ChatDigestStore interface {
	ChatDigests(ctx context.Context, workspaceID string) ([]ChatDigest, error)
}
