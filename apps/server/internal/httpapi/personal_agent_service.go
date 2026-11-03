package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The Personal Agent (docs/personal-agent.md) lives in personalagent and
// its flow packages (run, knowledge, assistant); httpapi resolves who asks,
// decodes and encodes: the REST routes (personal_agent*.go), its MCP tools
// (mcp_personal_agent.go) and the Feishu desk (personal_agent_feishu.go),
// over the ports in personal_agent_ports.go.

// presentSession is a session as people read it: with the role it acts
// in, personal_agent for the person's conversations with their assistant.
// Only what is shown carries it; everything else reads the stored role.
func (s *Server) presentSession(ctx context.Context, session store.AgentSession) store.AgentSession {
	session.Role = s.assistant.SessionRole(ctx, session)
	return session
}

// presentSessions presents each of sessions.
func (s *Server) presentSessions(ctx context.Context, sessions []store.AgentSession) []store.AgentSession {
	for index := range sessions {
		sessions[index] = s.presentSession(ctx, sessions[index])
	}
	return sessions
}

// requestLanguage is the first language the browser asks for, as a tag
// the assistant speaks ("en", "zh-CN"), or "" for any other.
func requestLanguage(r *http.Request) string {
	first, _, _ := strings.Cut(r.Header.Get("Accept-Language"), ",")
	first, _, _ = strings.Cut(strings.ToLower(strings.TrimSpace(first)), ";")
	switch {
	case strings.HasPrefix(first, "zh"):
		return "zh-CN"
	case strings.HasPrefix(first, "en"):
		return "en"
	}
	return ""
}
