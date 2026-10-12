package httpapi

import (
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/builtinskills"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// foundrySkillName is the built-in skill that teaches agents the Foundry tools.
const foundrySkillName = "foundry"

// foundryToolRoles are the kinds of session whose Foundry tools differ, in
// the order people read them, with the role and verifier flag
// mcpToolAvailability reads off such a session.
var foundryToolRoles = []struct {
	id       string
	role     string
	verifier bool
}{
	{"session", "", false},
	{"issue_execution", store.AgentSessionRoleIssueExecution, false},
	{"issue_clarification", store.AgentSessionRoleIssueClarification, false},
	{"verifier", "", true},
}

// foundrySkillDetail shows what the foundry skill gives agents, read from
// what agents get: the tool catalog with the rule that filters it per role,
// and the embedded SKILL.md.
func foundrySkillDetail() (store.FoundrySkillDetail, bool) {
	var detail store.FoundrySkillDetail
	for _, skill := range builtinskills.All() {
		if skill.Name != foundrySkillName {
			continue
		}
		if detail.Name == "" {
			detail = store.FoundrySkillDetail{
				Name:        skill.Name,
				Description: skill.Description,
				Source:      skill.Source,
				Manifest:    skill.Manifest,
			}
			for _, section := range builtinskills.Guidance(skill.Manifest) {
				detail.Guidance = append(detail.Guidance, store.SkillGuidanceSection{Heading: section.Heading, Points: section.Points})
			}
		}
		detail.Revisions = append(detail.Revisions, store.BuiltinSkillRevision{Runtime: skill.Runtime, Revision: skill.Revision})
	}
	if detail.Name == "" {
		return detail, false
	}
	for _, tool := range remoteMCPTools {
		capability := store.FoundryToolCapability{
			Name:     tool.name,
			Summary:  tool.summary,
			Limits:   append([]string{}, tool.limits...),
			ReadOnly: tool.readOnly,
			Roles:    []string{},
		}
		for _, role := range foundryToolRoles {
			if mcpToolAllowed(role.role, role.verifier, tool.name) == nil {
				capability.Roles = append(capability.Roles, role.id)
			}
		}
		detail.Tools = append(detail.Tools, capability)
	}
	return detail, true
}

func (s *Server) handleFoundrySkill(w http.ResponseWriter, r *http.Request) {
	detail, ok := foundrySkillDetail()
	if !ok {
		writeError(w, http.StatusNotFound, "the foundry skill is not built in")
		return
	}
	writeJSON(w, http.StatusOK, detail)
}
