package httpapi

import (
	"context"
)

// integrationStarter is a job the server starts by itself that reaches a
// third-party service. Each one consults the integrations switch itself
// (FOUNDRY_INTEGRATIONS, ServerOptions.Integrations), so the other ways into
// the same work (a bot saved in the UI, a token minted for a session, a
// device coming back) are switched off too.
//
// TestIntegrationStartersHonourTheSwitch runs every starter listed here
// against a trap, once on (it must reach the trap) and once off (it must
// not, and must return); a starter without a probe there fails the test.
// Start any new job of this kind from this list; backgroundJobs starts them.
type integrationStarter struct {
	name  string
	start func(ctx context.Context)
}

func (s *Server) integrationStarters() []integrationStarter {
	return []integrationStarter{
		// One long connection per Feishu app (feishuevents.Hub), opened
		// here for the apps workspace bots run on; agent subscriptions open
		// theirs on demand through the same switch.
		{name: "feishu-event-connections", start: s.startFeishuBots},
		// Hourly refresh of Connectors accounts that asked to be kept alive.
		{name: "connectors-keep-alive", start: s.RunExternalAccountKeepAlive},
		// A minute after start, then daily: followed repositories on
		// GitHub/npm (or through their device).
		{name: "skill-repository-checks", start: s.CheckSkillRepositories},
	}
}

func (s *Server) startFeishuBots(ctx context.Context) {
	s.feishu.StartAllConfiguredBots(ctx)
}
