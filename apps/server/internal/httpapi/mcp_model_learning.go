package httpapi

import (
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func mcpModelNoteTarget(call mcpCall) modelNoteTarget {
	return modelNoteTarget{
		ProviderKind: mcpArgString(call.args, "providerKind"),
		ProviderID:   mcpArgString(call.args, "providerId"),
		Runtime:      mcpArgString(call.args, "runtime"),
		Model:        mcpArgString(call.args, "model"),
	}
}

func (s *Server) getModelNotesForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	target := mcpModelNoteTarget(call)
	m, err := s.modelNoteManager(ctx, call.actor, target)
	if err != nil {
		return "", err
	}
	offset := max(mcpArgNumber(call.args, "offset", 0), 0)
	limit := min(max(mcpArgNumber(call.args, "limit", defaultModelNotePage), 1), maxModelNotePage)
	page, err := s.modelNotesPage(ctx, m.userID, target, offset, limit)
	if err != nil {
		return "", err
	}
	return encodeJSON(page)
}

func (s *Server) appendModelNoteForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	target := mcpModelNoteTarget(call)
	m, err := s.modelNoteManager(ctx, call.actor, target)
	if err != nil {
		return "", err
	}
	user, sessionID, err := s.modelNoteAuthor(ctx, call.actor, m)
	if err != nil {
		return "", err
	}
	note, err := s.store.AppendModelNote(ctx, store.StoredModelNote{
		OwnerUserID: m.userID, ProviderKind: strings.TrimSpace(target.ProviderKind),
		ProviderID: strings.TrimSpace(target.ProviderID), Runtime: strings.TrimSpace(target.Runtime),
		Model: strings.TrimSpace(target.Model), Body: mcpArgString(call.args, "body"),
		AuthorUserID: user.ID, AuthorName: user.DisplayName, AuthorSessionID: sessionID,
	})
	if err != nil {
		return "", err
	}
	return encodeJSON(publicModelNote(note))
}

func (s *Server) getExecutionDefaultForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	m, err := s.providerManagerFor(ctx, call.actor)
	if err != nil {
		return "", err
	}
	view, err := s.executionDefaults(ctx, m.userID, strings.TrimSpace(call.workspace))
	if err != nil {
		return "", err
	}
	return encodeJSON(view)
}
