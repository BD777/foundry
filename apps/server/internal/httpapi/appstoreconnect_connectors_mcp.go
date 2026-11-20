package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// connector_instances for the built-in App Store Connect connector: the same
// actions as the Web page, with the .p8 read by the session Worker from
// secretFiles.privateKey. instanceId is the key's appId.

const appStoreConnectKind = "appstoreconnect"

type appStoreConnectInstanceField struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Secret   bool   `json:"secret,omitempty"`
	Required bool   `json:"required"`
	Help     string `json:"help"`
}

var appStoreConnectInstanceFields = []appStoreConnectInstanceField{
	{ID: "issuerId", Label: "Issuer ID", Required: true, Help: "UUID above the team key list in App Store Connect, Users and Access, Integrations; not secret."},
	{ID: "keyId", Label: "Key ID", Required: true, Help: "The ID in the key's file name AuthKey_<KeyID>.p8; not secret."},
	{ID: "privateKey", Label: "Private key (.p8)", Secret: true, Required: true, Help: "Pass as secretFiles.privateKey with the downloaded .p8 path."},
}

type appStoreConnectInstanceSummary struct {
	ID        string `json:"id"`
	AccountID string `json:"accountId"`
	Kind      string `json:"kind"`
	Label     string `json:"label"`
	IssuerID  string `json:"issuerId"`
	KeyID     string `json:"keyId"`
	Status    string `json:"status"`
	UpdatedAt string `json:"updatedAt,omitempty"`
}

func appStoreConnectInstanceSummaryOf(connection store.AppStoreConnectConnection) appStoreConnectInstanceSummary {
	return appStoreConnectInstanceSummary{
		ID: connection.AppID, AccountID: connection.AccountID, Kind: appStoreConnectKind,
		Label: connection.Label, IssuerID: connection.IssuerID, KeyID: connection.KeyID,
		Status: connection.Status, UpdatedAt: connection.UpdatedAt,
	}
}

func appStoreConnectKeyInputFromMCP(args map[string]json.RawMessage, secrets map[string]string) (store.SaveAppStoreConnectKeyInput, error) {
	fields := map[string]string{}
	if raw, ok := args["fields"]; ok {
		if err := json.Unmarshal(raw, &fields); err != nil {
			return store.SaveAppStoreConnectKeyInput{}, &statusError{http.StatusBadRequest, errors.New("fields must map field ids to string values")}
		}
	}
	for id, value := range fields {
		switch id {
		case "issuerId", "keyId":
		case "privateKey":
			if strings.TrimSpace(value) != "" {
				return store.SaveAppStoreConnectKeyInput{}, &statusError{http.StatusBadRequest, errors.New("privateKey cannot be supplied in fields; use secretFiles.privateKey so the session worker reads the .p8 file")}
			}
		default:
			return store.SaveAppStoreConnectKeyInput{}, &statusError{http.StatusBadRequest, errors.New("unknown App Store Connect field " + id + "; use issuerId and keyId")}
		}
	}
	for id := range secrets {
		if id != "privateKey" {
			return store.SaveAppStoreConnectKeyInput{}, &statusError{http.StatusBadRequest, errors.New("App Store Connect secretFiles accepts only privateKey")}
		}
	}
	return store.SaveAppStoreConnectKeyInput{
		IssuerID:   strings.TrimSpace(fields["issuerId"]),
		KeyID:      strings.TrimSpace(fields["keyId"]),
		PrivateKey: strings.TrimSpace(secrets["privateKey"]),
		Label:      mcpArgString(args, "label"),
	}, nil
}

func (s *Server) appStoreConnectInstancesForMCP(call mcpCall, caller connectorInstanceSession, action, instanceID string) (string, error) {
	ctx := call.r.Context()
	secrets := map[string]string{}
	if raw, ok := call.args["secretFiles"]; ok {
		var unresolved map[string]json.RawMessage
		if err := json.Unmarshal(raw, &unresolved); err != nil || len(unresolved) > 0 {
			return "", &statusError{http.StatusBadRequest, errors.New("secretFiles must be resolved by the session worker before this request reaches Foundry")}
		}
	}
	if raw, ok := call.args["secretValues"]; ok {
		if err := json.Unmarshal(raw, &secrets); err != nil {
			return "", &statusError{http.StatusBadRequest, errors.New("secretValues must map secret field ids to strings")}
		}
		if call.r.Header.Get(connectorInstanceSecretProxyHeader) != connectorInstanceSecretProxyValue {
			return "", &statusError{http.StatusForbidden, errors.New("secretValues are accepted only from the session worker's secret proxy")}
		}
	}
	fail := func(err error) (string, error) {
		var refusal *statusError
		if !errors.As(err, &refusal) {
			err = appStoreConnectConnectorError(err)
		}
		return "", redactConnectorInstanceError(err, secrets)
	}
	answer := func(value any) (string, error) {
		text, err := encodeJSON(value)
		return redactConnectorInstanceText(text, secrets), redactConnectorInstanceError(err, secrets)
	}

	switch action {
	case "list":
		access, err := s.connectorInstancePermission(ctx, caller)
		if err != nil {
			return "", err
		}
		keys, err := s.connectors.ServerHeld.ListAppStoreConnectKeys(ctx, caller.ownerID)
		if err != nil {
			return fail(err)
		}
		summaries := []appStoreConnectInstanceSummary{}
		for _, key := range keys {
			if access.Applicable && !access.AllowsConnector(key.AccountID) {
				continue
			}
			summaries = append(summaries, appStoreConnectInstanceSummaryOf(key))
		}
		levels := []string{}
		for _, level := range externalaccounts.AppStoreConnectAccessLevels {
			levels = append(levels, level.Name)
		}
		return answer(map[string]any{
			"kind":   appStoreConnectKind,
			"fields": appStoreConnectInstanceFields,
			"binding": map[string]any{
				"resourceIds":  "App ids from check (or create's apps) that the workspace may manage",
				"accessLevels": levels,
			},
			"instances": summaries,
		})
	case "probe":
		return "", &statusError{http.StatusBadRequest, errors.New("App Store Connect has no probe; create validates the key with Apple before saving it")}
	case "create":
		input, err := appStoreConnectKeyInputFromMCP(call.args, secrets)
		if err != nil {
			return fail(err)
		}
		connection, err := s.connectors.ServerHeld.CreateAppStoreConnectKey(ctx, caller.ownerID, input)
		if err != nil {
			return fail(err)
		}
		return answer(s.appStoreConnectKeyWithApps(call, connection))
	}

	if instanceID == "" {
		return "", &statusError{http.StatusBadRequest, errors.New("instanceId is required for " + action)}
	}
	key, app, err := s.appStoreConnectKeyForMCP(call, caller, instanceID)
	if err != nil {
		return fail(err)
	}
	if err := s.requireConnectorInstanceWrite(ctx, caller, key.AccountID); err != nil {
		return "", err
	}

	switch action {
	case "update":
		input, err := appStoreConnectKeyInputFromMCP(call.args, secrets)
		if err != nil {
			return fail(err)
		}
		connection, err := s.connectors.ServerHeld.ReplaceAppStoreConnectKey(ctx, caller.ownerID, app.ID, input)
		if err != nil {
			return fail(err)
		}
		return answer(s.appStoreConnectKeyWithApps(call, connection))
	case "check":
		return answer(s.appStoreConnectKeyWithApps(call, key))
	case "revoke":
		connection, err := s.connectors.ServerHeld.RevokeAppStoreConnectKey(ctx, caller.ownerID, app.ID, caller.ownerID)
		if err != nil {
			return fail(err)
		}
		return answer(appStoreConnectInstanceSummaryOf(connection))
	case "delete":
		return "", &statusError{http.StatusBadRequest, errors.New("an App Store Connect key is removed by revoke")}
	case "bind_workspace", "unbind_workspace":
		workspaceID := strings.TrimSpace(mcpArgString(call.args, "workspaceId"))
		if err := s.requireConnectorInstanceWorkspace(ctx, caller, workspaceID); err != nil {
			return "", err
		}
		actor := WorkspaceActor{UserID: caller.ownerID, SessionID: caller.session.ID}
		if action == "unbind_workspace" {
			if _, err := s.ChangeWorkspaceConnectors(ctx, actor, workspaceID, nil, []string{key.AccountID}); err != nil {
				return "", err
			}
			return answer(map[string]any{"status": "unbind", "kind": appStoreConnectKind, "workspaceId": workspaceID, "instance": appStoreConnectInstanceSummaryOf(key)})
		}
		var appIDs []string
		if raw, ok := call.args["resourceIds"]; ok {
			if err := json.Unmarshal(raw, &appIDs); err != nil {
				return "", &statusError{http.StatusBadRequest, errors.New("resourceIds must be a list of App ids")}
			}
		}
		if len(appIDs) == 0 {
			return "", &statusError{http.StatusBadRequest, errors.New("resourceIds must name the App ids this workspace may manage; check lists them")}
		}
		visible, err := s.connectors.ServerHeld.ListAppStoreApps(ctx, app)
		if err != nil {
			return fail(err)
		}
		for _, id := range appIDs {
			if !slices.ContainsFunc(visible, func(candidate store.AppStoreConnectApp) bool { return candidate.ID == id }) {
				return "", &statusError{http.StatusBadRequest, errors.New("App " + id + " is not visible to this key; check lists the Apps it sees")}
			}
		}
		bindings, err := s.store.ListWorkspaceExternalAccounts(ctx, workspaceID)
		if err != nil {
			return "", err
		}
		own := []string{}
		for _, binding := range bindings {
			if binding.GrantedBy == caller.ownerID && binding.AccountID != key.AccountID {
				own = append(own, binding.AccountID)
			}
		}
		own = append(own, key.AccountID)
		if _, err := s.SetWorkspaceConnectors(ctx, actor, workspaceID, own, map[string][]string{key.AccountID: appIDs}); err != nil {
			return "", err
		}
		level := mcpArgString(call.args, "access")
		if level == "" {
			level = s.cloudflareBindingAccess(ctx, workspaceID, key.AccountID)
		}
		if err := s.setAppStoreConnectBindingAccess(ctx, workspaceID, key.AccountID, caller.ownerID, level); err != nil {
			return "", err
		}
		return answer(map[string]any{
			"status": "bind", "kind": appStoreConnectKind, "workspaceId": workspaceID,
			"resourceIds": appIDs, "access": s.cloudflareBindingAccess(ctx, workspaceID, key.AccountID),
			"instance": appStoreConnectInstanceSummaryOf(key),
		})
	default:
		return "", &statusError{http.StatusBadRequest, errors.New("action must be list, create, update, check, revoke, bind_workspace or unbind_workspace")}
	}
}

// appStoreConnectKeyForMCP is the caller's key with appId, and its app.
func (s *Server) appStoreConnectKeyForMCP(call mcpCall, caller connectorInstanceSession, appID string) (store.AppStoreConnectConnection, store.ExternalProviderApp, error) {
	ctx := call.r.Context()
	keys, err := s.connectors.ServerHeld.ListAppStoreConnectKeys(ctx, caller.ownerID)
	if err != nil {
		return store.AppStoreConnectConnection{}, store.ExternalProviderApp{}, err
	}
	for _, key := range keys {
		if key.AppID != appID {
			continue
		}
		app, err := s.store.GetExternalProviderApp(ctx, key.AppID)
		if err != nil || app.Provider != appStoreConnectKind || app.OwnerUserID != caller.ownerID {
			break
		}
		return key, app, nil
	}
	return store.AppStoreConnectConnection{}, store.ExternalProviderApp{}, store.ErrExternalAppNotFound
}

// appStoreConnectKeyWithApps is a key and the Apps it sees now, so the next
// call can bind them; a listing failure is reported beside the key.
func (s *Server) appStoreConnectKeyWithApps(call mcpCall, connection store.AppStoreConnectConnection) map[string]any {
	result := map[string]any{"instance": appStoreConnectInstanceSummaryOf(connection)}
	app, err := s.store.GetExternalProviderApp(call.r.Context(), connection.AppID)
	if err == nil {
		var apps []store.AppStoreConnectApp
		if apps, err = s.connectors.ServerHeld.ListAppStoreApps(call.r.Context(), app); err == nil {
			result["apps"] = apps
			return result
		}
	}
	result["appsError"] = appStoreConnectConnectorError(err).Error()
	return result
}
