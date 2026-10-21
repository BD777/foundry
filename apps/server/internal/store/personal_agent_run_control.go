package store

import (
	"context"
	"errors"
)

var ErrPersonalAgentInputUnconfirmed = errors.New("native input has not confirmed its end; reconcile it before retrying")

// State reports observation, not desired state: a disconnected execution is
// stop_requested until its own input has a native cancellation/terminal receipt.
type PersonalAgentRunControl struct {
	NativeEndedAt     string `json:"nativeEndedAt,omitempty"`
	NativeStatus      string `json:"nativeStatus,omitempty"`
	WaitingReason     string `json:"waitingReason,omitempty"`
	DispatchAttempted bool   `json:"dispatchAttempted"`
	ID                string `json:"id"`
	UserID            string `json:"-"`
	SnapshotID        string `json:"snapshotId,omitempty"`
	SessionID         string `json:"sessionId"`
	InputID           string `json:"inputId"`
	Role              string `json:"role"`
	State             string `json:"state"`
	StopReason        string `json:"stopReason,omitempty"`
	ObservedTokens    int64  `json:"observedTokens"`
	UsageState        string `json:"usageState"`
	TokenBudget       int64  `json:"tokenBudget"`
	TimeoutMinutes    int    `json:"timeoutMinutes"`
	LastUsageAt       string `json:"lastUsageAt,omitempty"`
	ConfirmedAt       string `json:"confirmedAt,omitempty"`
	Revision          int64  `json:"revision"`
	UpdatedAt         string `json:"updatedAt"`
}

type PersonalAgentRunControlStore interface {
	ActivePersonalAgentRunControlsForUser(context.Context, string) ([]PersonalAgentRunControl, error)
	NotePersonalAgentNativeEnd(context.Context, string, string, string) error
	AuthorizePersonalAgentDispatch(context.Context, string, string) (bool, error)
	EnsurePersonalAgentRunControl(context.Context, PersonalAgentRunControl) (PersonalAgentRunControl, error)
	GetPersonalAgentRunControl(context.Context, string, string) (PersonalAgentRunControl, error)
	ListPersonalAgentRunControls(context.Context, string) ([]PersonalAgentRunControl, error)
	ActivePersonalAgentRunControls(context.Context) ([]PersonalAgentRunControl, error)
	SavePersonalAgentRunControl(context.Context, PersonalAgentRunControl) (PersonalAgentRunControl, error)
	RequestPersonalAgentRunStop(context.Context, string, string, string) (PersonalAgentRunControl, error)
	CancelPersonalAgentInput(context.Context, string, string, string) (AgentSession, bool, error)
}
