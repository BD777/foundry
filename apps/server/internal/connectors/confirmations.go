package connectors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// ConnectorConfirmationSpec is saved in a proposal's spec. It identifies an
// exact gateway request without retaining its body or stand-in credential.
type ConnectorConfirmationSpec struct {
	AccountID   string `json:"accountId"`
	AccountName string `json:"accountName"`
	Connector   string `json:"connector"`
	Risk        string `json:"risk"`
	Method      string `json:"method"`
	Path        string `json:"path"`
	Query       string `json:"query,omitempty"`
	BodyDigest  string `json:"bodyDigest"`
	Fingerprint string `json:"fingerprint"`
	Summary     string `json:"summary"`
}

// Confirmations turns risk writes into the same proposal cards assistant
// writes use. Accepting a card marks the proposal accepted; the exact retry
// consumes it once.
type Confirmations struct {
	Store       store.PersonalAgentStore
	ProposalTTL time.Duration
	Now         func() time.Time
	OnCreated   func(store.PersonalAgentProposal)
	OnChanged   func(store.PersonalAgentProposal)
}

var _ gateway.Confirmer = (*Confirmations)(nil)

// Review creates or consumes the confirmation for request.
func (c *Confirmations) Review(ctx context.Context, request gateway.ConfirmationRequest) (gateway.ConfirmationDecision, *gateway.Denial) {
	if c == nil || c.Store == nil || request.Lease == nil {
		return gateway.ConfirmationDecision{}, &gateway.Denial{
			Reason: gateway.ReasonInternal, Err: errors.New("connector confirmations are not configured"),
		}
	}
	if c.ProposalTTL <= 0 {
		return gateway.ConfirmationDecision{}, &gateway.Denial{
			Reason: gateway.ReasonInternal, Err: errors.New("connector confirmation TTL is not configured"),
		}
	}
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	nowValue := now().UTC()
	nowText := nowValue.Format(time.RFC3339Nano)
	proposals, err := c.Store.ListPersonalAgentProposals(ctx, request.Lease.Grant.UserID, []string{
		store.PersonalAgentProposalPending, store.PersonalAgentProposalAccepted,
	})
	if err != nil {
		return gateway.ConfirmationDecision{}, &gateway.Denial{Reason: gateway.ReasonInternal, Err: err}
	}
	for _, proposal := range proposals {
		if proposal.Kind != store.PersonalAgentProposalConnectorWrite || proposal.SessionID != request.Lease.Grant.SessionID {
			continue
		}
		var spec ConnectorConfirmationSpec
		if json.Unmarshal(proposal.Spec, &spec) != nil || spec.Fingerprint != request.Fingerprint {
			continue
		}
		if proposal.ExpiresAt <= nowText {
			_, _ = c.Store.SetPersonalAgentProposalStatus(ctx, proposal.UserID, proposal.ID,
				[]string{proposal.Status}, store.PersonalAgentProposalExpired, "", "expired before the request was retried")
			continue
		}
		if proposal.Status == store.PersonalAgentProposalPending {
			return gateway.ConfirmationDecision{
				ProposalID: proposal.ID, Summary: proposal.Summary, ExpiresAt: proposal.ExpiresAt,
			}, nil
		}
		if proposal.Status == store.PersonalAgentProposalAccepted {
			if _, err := c.Store.SetPersonalAgentProposalStatus(ctx, proposal.UserID, proposal.ID,
				[]string{store.PersonalAgentProposalAccepted}, store.PersonalAgentProposalApplied, "", ""); err == nil {
				proposal.Status = store.PersonalAgentProposalApplied
				if c.OnChanged != nil {
					c.OnChanged(proposal)
				}
				return gateway.ConfirmationDecision{Approved: true, ProposalID: proposal.ID, Summary: proposal.Summary}, nil
			}
			// Another retry consumed it. This request now needs a fresh card.
		}
	}

	summary := strings.TrimSpace(request.Summary)
	if summary == "" {
		summary = fmt.Sprintf("The assistant wants to make this %s change: %s %s.", request.Lease.Account.Provider, request.Method, request.Path)
	}
	spec := ConnectorConfirmationSpec{
		AccountID: request.Lease.Account.ID, AccountName: request.Lease.Account.Label,
		Connector: request.Lease.Account.Provider,
		Risk:      request.Need.Risk, Method: request.Method, Path: request.Path, Query: request.Query,
		BodyDigest: request.BodyDigest, Fingerprint: request.Fingerprint, Summary: summary,
	}
	raw, err := json.Marshal(spec)
	if err != nil {
		return gateway.ConfirmationDecision{}, &gateway.Denial{Reason: gateway.ReasonInternal, Err: err}
	}
	proposal, err := c.Store.CreatePersonalAgentProposal(ctx, store.PersonalAgentProposal{
		UserID: request.Lease.Grant.UserID, SessionID: request.Lease.Grant.SessionID,
		Kind: store.PersonalAgentProposalConnectorWrite, WorkspaceID: request.Lease.Session.WorkspaceID,
		Spec: raw, Summary: summary,
		ExpiresAt: nowValue.Add(c.ProposalTTL).Format(time.RFC3339Nano),
	})
	if err != nil {
		return gateway.ConfirmationDecision{}, &gateway.Denial{Reason: gateway.ReasonInternal, Err: err}
	}
	if c.OnCreated != nil {
		c.OnCreated(proposal)
	}
	return gateway.ConfirmationDecision{
		ProposalID: proposal.ID, Summary: proposal.Summary, ExpiresAt: proposal.ExpiresAt,
	}, nil
}
