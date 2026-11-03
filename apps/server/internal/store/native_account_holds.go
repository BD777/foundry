package store

import "context"

// NativeAccountHoldStore keeps dispatch identity and user recovery together.
type NativeAccountHoldStore interface {
	BindNativeAccount(context.Context, AgentSession) error
	ObserveNativeAccountHold(context.Context, string, string, string) error
	ResumeNativeAccount(context.Context, string, string, string) error
}
