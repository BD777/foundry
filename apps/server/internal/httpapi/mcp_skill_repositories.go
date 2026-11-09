package httpapi

import "github.com/foundry-dev/foundry/apps/server/internal/store"

// setSkillRepositorySource is the page's admin-only source change as a
// Foundry tool.
var repositorySourceMCPTools = map[string]bool{
	"set_skill_repository_source": true,
}

func (s *Server) setSkillRepositorySourceForMCP(call mcpCall) (string, error) {
	repo, err := s.setSkillRepositorySource(call.r.Context(), call.actor,
		mcpArgString(call.args, "repositoryId"),
		repositorySourceInput{
			DeviceID: mcpArgString(call.args, "deviceId"),
			Registry: mcpArgString(call.args, "registry"),
		})
	if err != nil {
		return "", err
	}
	return encodeJSON(struct {
		ID          string `json:"id"`
		URL         string `json:"url"`
		DeviceID    string `json:"deviceId"`
		DeviceName  string `json:"deviceName"`
		Registry    string `json:"registry"`
		CheckStatus string `json:"checkStatus"`
	}{
		ID:          repo.ID,
		URL:         repo.URL,
		DeviceID:    repo.FetchDeviceID,
		DeviceName:  repo.FetchDeviceName,
		Registry:    repo.Registry,
		CheckStatus: skillRepositoryCheckStatus(repo),
	})
}

func skillRepositoryCheckStatus(repo store.SkillRepository) string {
	switch {
	case repo.CheckWaiting:
		return "waiting"
	case repo.Error != "":
		return store.CheckFailed
	case repo.CheckedAt != "":
		return store.CheckPassed
	default:
		return "not checked"
	}
}
