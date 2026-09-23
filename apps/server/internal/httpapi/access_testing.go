package httpapi

import "context"

// fullScopeForTests grants the package-test owner every workspace and device.
// Reachable only when testFullAccess is set, which no exported constructor
// does.
func (s *Server) fullScopeForTests(_ context.Context, userID string) (accessScope, error) {
	return accessScope{userID: userID, admin: true, roles: map[string]string{}, owned: map[string]bool{}, all: true}, nil
}
