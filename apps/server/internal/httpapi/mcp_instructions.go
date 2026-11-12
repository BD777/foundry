package httpapi

import (
	"context"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

const mcpInstructionsMaxChars = 512

// mcpInstructions is the MCP initialize result's instructions. It states the
// server's purpose and hard boundaries; the foundry skill holds how and when
// to use the tools. Only facts no tool or variable carries are added: who
// else uses the caller's device system account.
func (s *Server) mcpInstructions(ctx context.Context, actor Actor) string {
	instructions := "Foundry runs Claude Code and Codex sessions on people's own devices and exposes MCP tools for sessions, workspaces, devices and connected accounts. The foundry skill contains usage guidance. Connected accounts reach their services through Foundry; their own login, logout and profile-switch commands are disabled for these sessions, and missing access is re-authorized in Foundry Connectors."
	if names := s.sharedSystemAccountNames(ctx, actor); len(names) > 0 {
		instructions = appendSharedSystemAccount(instructions, names)
	}
	return instructions
}

func appendSharedSystemAccount(instructions string, names []string) string {
	remaining := mcpInstructionsMaxChars - utf8.RuneCountInString(instructions) - 1
	if shared := textcut.Excerpt(sharedSystemAccountInstruction(names), remaining); shared != "" {
		instructions += "\n" + shared
	}
	return instructions
}

// sharedSystemAccountInstruction names the other people on the device's
// system account, so an agent never assumes what is there is private.
func sharedSystemAccountInstruction(names []string) string {
	return "This device's system account is shared with " + joinNames(names) + "; its files and Claude/Codex sign-ins are not private."
}

// sharedSystemAccountNames are the other people whose devices use the
// system account of the caller's session's device; none for a caller that
// is not a session.
func (s *Server) sharedSystemAccountNames(ctx context.Context, actor Actor) []string {
	if !actor.Agent() {
		return nil
	}
	session, err := s.store.GetAgentSessionRecord(ctx, actor.Identity.SessionID)
	if err != nil || session.DeviceID == "" {
		return nil
	}
	return s.sharedAccountDevices(ctx)[session.DeviceID]
}
