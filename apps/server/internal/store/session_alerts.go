package store

import (
	"context"
	"time"
)

// SessionAlert is one system incident Foundry noticed in a session that
// another session started. It is separate from the session's result report:
// resolving a report as superseded never resolves or deduplicates an alert.
type SessionAlert struct {
	ID                 string     `json:"id"`
	RecipientSessionID string     `json:"recipientSessionId"`
	ChildSessionID     string     `json:"childSessionId"`
	SourceInputID      string     `json:"sourceInputId"`
	Code               string     `json:"code"`
	DedupeKey          string     `json:"dedupeKey"`
	Detail             string     `json:"detail,omitempty"`
	WillRetry          bool       `json:"willRetry,omitempty"`
	Occurrences        int        `json:"occurrences"`
	FirstSeenAt        time.Time  `json:"firstSeenAt"`
	LastSeenAt         time.Time  `json:"lastSeenAt"`
	NotifyAfter        time.Time  `json:"notifyAfter"`
	NotifiedAt         *time.Time `json:"notifiedAt,omitempty"`
	ResolvedAt         *time.Time `json:"resolvedAt,omitempty"`
	InboxInputID       string     `json:"inboxInputId,omitempty"`
}

// SessionAlertInput records a new observation of an incident. Observations
// with the same recipient, child and dedupe key share one unresolved alert
// and increment its occurrence count.
type SessionAlertInput struct {
	RecipientSessionID string
	ChildSessionID     string
	SourceInputID      string
	Code               string
	DedupeKey          string
	Detail             string
	WillRetry          bool
	ObservedAt         time.Time
	NotifyAfter        time.Time
}

// SessionAlertStore keeps system alerts independently of turn-end reports.
type SessionAlertStore interface {
	RecordSessionAlert(ctx context.Context, input SessionAlertInput) (SessionAlert, bool, error)
	// DueSessionAlerts lists unresolved, unnotified alerts whose delay has
	// expired, oldest first.
	DueSessionAlerts(ctx context.Context, now time.Time, limit int) ([]SessionAlert, error)
	// MarkSessionAlertNotified records the inbox message carrying the alert.
	// It changes nothing if the alert was already notified or resolved.
	MarkSessionAlertNotified(ctx context.Context, id, inboxInputID string, at time.Time) (bool, error)
	// ResolveSessionAlerts closes unresolved alerts of one child, optionally
	// only one code. Recovery closes them so a later failure can alert again.
	ResolveSessionAlerts(ctx context.Context, childSessionID, code string, at time.Time) (int, error)
	// SessionAlertsForChild lists a child's alerts, newest first.
	SessionAlertsForChild(ctx context.Context, childSessionID string, limit int) ([]SessionAlert, error)
}
