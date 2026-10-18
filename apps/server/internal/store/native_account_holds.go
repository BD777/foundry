package store

import "context"

// NativeAccountHold is Foundry's durable block, not an online health claim.
type NativeAccountHold struct {
	ID           string `json:"id"`
	Code         string `json:"code"`
	ObservedAt   string `json:"observedAt"`
	AccountLabel string `json:"accountLabel"`
}

// NativeAccountHoldStore keeps dispatch identity and user recovery together.
type NativeAccountHoldStore interface {
	BindNativeAccount(context.Context, AgentSession) error
	ObserveNativeAccountHold(context.Context, string, string, string) error
	ResumeNativeAccount(context.Context, string, string, string) error
}
