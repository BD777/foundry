package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// workerGroupsForMCP lists the person's worker groups or saves one, as the
// Model providers page's worker group editor does.
func (s *Server) workerGroupsForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	m, err := s.providerManagerFor(ctx, call.actor)
	if err != nil {
		return "", err
	}
	switch action := mcpArgString(call.args, "action"); action {
	case "list":
		groups, err := s.store.ListWorkerGroups(ctx, m.userID)
		if err != nil {
			return "", err
		}
		result := make([]store.WorkerGroup, len(groups))
		for index, group := range groups {
			view, err := s.workerGroupView(ctx, group)
			if err != nil {
				return "", err
			}
			result[index] = view
		}
		return encodeJSON(map[string]any{"groups": result})
	case "save":
		var input store.WorkerGroupInput
		if raw, ok := call.args["members"]; ok {
			if err := json.Unmarshal(raw, &input.Members); err != nil {
				return "", &statusError{http.StatusBadRequest, errors.New("members: " + err.Error())}
			}
		}
		input.Label = mcpArgString(call.args, "label")
		id := mcpArgString(call.args, "id")
		if id == "" && input.Label == "" {
			return "", &statusError{http.StatusBadRequest, errors.New("label is required to create a worker group")}
		}
		if id != "" && input.Label == "" {
			current, err := s.store.GetWorkerGroup(ctx, id)
			if err == nil && current.OwnerUserID == m.userID {
				input.Label = current.Label
			}
		}
		saved, err := s.saveWorkerGroup(ctx, m, id, input)
		if err != nil {
			return "", err
		}
		return encodeJSON(saved)
	default:
		return "", &statusError{http.StatusBadRequest, errors.New("action must be list or save")}
	}
}
