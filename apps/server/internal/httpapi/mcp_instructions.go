package httpapi

import (
	"context"
	"strings"
)

// mcpInstructions is the MCP initialize result's instructions: how and when
// to use Foundry's tools, the server-wide guidance the native clients load
// themselves (Claude Code keeps 4,096 characters, Codex reads the first 512
// as a summary). It states the contract, not live state: what a device
// offers is read with list_resources when it matters. Only facts about the
// caller's session that no tool or variable carries are added: who else
// uses its device's system account.
func (s *Server) mcpInstructions(ctx context.Context, actor Actor) string {
	available := s.mcpToolAvailability(ctx, actor)
	lines := []string{
		"Foundry runs Claude Code and Codex sessions on people's own devices and connects them: these tools read and steer other sessions, workspaces and devices, lease device resources and reach accounts Foundry holds. $FOUNDRY_SESSION_ID is your session, $FOUNDRY_WORKSPACE its folder. The foundry skill explains Foundry ids (sess_…, ws_…, dev_…, iss_…) and when to start a session.",
		"",
	}
	if available("list_resources") == nil {
		lines = append(lines, "- What a device offers (browsers, macOS screen control, compute, simulators) changes: read it with list_resources before saying something is unavailable. An instance that is not ready says why and what the device's owner can do.")
	}
	lines = append(lines,
		"- When $FOUNDRY_BROWSER_BIN is set, it holds a launcher for each browser on this device; a browser started through one is closed when your reply ends. The foundry skill's references/device-and-accounts.md says which to pick and how to use the person's sign-ins.",
		"- To show an image in your reply, save it under $FOUNDRY_WORKSPACE/.foundry/attachments/ and write <image path=\"its absolute path\">.",
		"- Accounts Foundry connected for this session (FEISHU_PROFILE, CLOUDFLARE_API_TOKEN, a device CLI's sign-in) reach their service through Foundry: never run the tool's own login, logout or profile switch. When access is missing, ask the person to re-authorize it in Foundry's Connectors. Details per tool: references/device-and-accounts.md.",
	)
	if names := s.sharedSystemAccountNames(ctx, actor); len(names) > 0 {
		lines = append(lines, sharedSystemAccountInstruction(names))
	}
	return strings.Join(lines, "\n")
}

// sharedSystemAccountInstruction names the other people on the device's
// system account, so an agent never assumes what is there is private.
func sharedSystemAccountInstruction(names []string) string {
	verb := " also use"
	if len(names) == 1 {
		verb = " also uses"
	}
	return "- This device's system account is shared: " + joinNames(names) + verb + " it in Foundry, with the same files and Claude/Codex sign-ins. Nothing on this device is private to the person you work for."
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
