package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The Model providers page as Foundry tools (docs/model-providers-design.md):
// a person manages their model providers by talking to their agent. Every
// tool runs the operation the page runs (profiles.go, profile_checks.go,
// agent_profiles_http.go, native_sign_in.go); only who may call it and the
// shape of the answer are decided here.
//
// Providers are the person's own: the API endpoints they own and the logins,
// launch environments and endpoints found on the devices they own. Only the
// person's own chats and assistant manage them (providerManagerFor); a key
// handed in is sealed on the server and never answered.

// modelProviderMCPTools are the tools that manage a person's providers.
var modelProviderMCPTools = map[string]bool{
	"list_model_providers":  true,
	"save_model_provider":   true,
	"delete_model_provider": true,
	"check_model_provider":  true,
	"set_model_defaults":    true,
	"sign_in_subscription":  true,
	"get_model_notes":       true,
	"append_model_note":     true,
	"get_execution_default": true,
}

var errProviderManagementRefused = &statusError{http.StatusForbidden, errors.New(
	"model providers are managed only for the person by their own chats and assistant; an Issue's sessions, verifiers and Foundry's own utility sessions cannot manage them")}

// Kinds of provider, in the order they are listed.
const (
	providerKindSubscription = "subscription"
	providerKindAPI          = "api"
	providerKindEnvironment  = "environment"
	providerKindDiscovered   = "discovered"
)

var providerKindOrder = map[string]int{
	providerKindSubscription: 0, providerKindAPI: 1, providerKindEnvironment: 2, providerKindDiscovered: 3,
}

const (
	defaultProviderPage = 20
	maxProviderPage     = 50
	// providerModelsShown caps the models a provider lists; modelCount has all.
	providerModelsShown = 20
)

// providerManager is the person an owned-resource tool acts for and the
// devices they own.
type providerManager struct {
	userID string
	admin  bool
	owned  map[string]bool
}

// providerManagerFor gates tools over the person's own providers and skill
// repository sources, and says for whom: a signed-in person for themselves,
// or an agent for the person who started its session when that session is one
// of the person's own chats or their assistant. An Issue's sessions (its
// execution, its clarification and every session they start), verifiers and
// utility sessions never do.
func (s *Server) providerManagerFor(ctx context.Context, actor Actor) (providerManager, error) {
	var userID string
	var admin bool
	switch {
	case actor.Agent():
		if actor.CommandLease() != "" {
			return providerManager{}, errProviderManagementRefused
		}
		session, err := s.store.GetAgentSessionRecord(ctx, actor.Identity.SessionID)
		if err != nil {
			return providerManager{}, errProviderManagementRefused
		}
		role := s.assistant.SessionRole(ctx, session)
		if session.CreatedByUserID == "" || strings.TrimSpace(session.IssueID) != "" ||
			role == store.AgentSessionRoleIssueExecution || role == store.AgentSessionRoleIssueClarification ||
			session.Source == store.SessionSourceVerification || session.Source == store.SessionSourceIssue ||
			slices.Contains(store.UtilitySessionSources, session.Source) {
			return providerManager{}, errProviderManagementRefused
		}
		user, err := s.store.GetUser(ctx, session.CreatedByUserID)
		if err != nil || !user.Active() {
			return providerManager{}, errProviderManagementRefused
		}
		userID = session.CreatedByUserID
		admin = user.Role == store.RoleAdmin
	case actor.Kind == ActorAccount && actor.AccountID() != "":
		userID = actor.AccountID()
		admin = actor.Account.Role == store.RoleAdmin
	default:
		return providerManager{}, errProviderManagementRefused
	}
	devices, err := s.store.DevicesOwnedBy(ctx, userID)
	if err != nil {
		return providerManager{}, err
	}
	owned := make(map[string]bool, len(devices))
	for _, deviceID := range devices {
		owned[deviceID] = true
	}
	return providerManager{userID: userID, admin: admin, owned: owned}, nil
}

func (m providerManager) device(deviceID string) error {
	if deviceID == "" {
		return &statusError{http.StatusBadRequest, errors.New("deviceId is required")}
	}
	if !m.owned[deviceID] {
		return &statusError{http.StatusNotFound, errors.New("device not found: " + deviceID + " (only devices you own; list_model_providers shows them)")}
	}
	return nil
}

// ownedProfile is a server profile the person owns.
func (s *Server) ownedProfile(ctx context.Context, m providerManager, id string) (store.ProfileDefinition, bool, error) {
	profile, err := s.store.GetProfile(ctx, id)
	if errors.Is(err, store.ErrProfileNotFound) {
		return store.ProfileDefinition{}, false, nil
	}
	if err != nil {
		return store.ProfileDefinition{}, false, err
	}
	return profile, profile.OwnerUserID == m.userID, nil
}

// providerView is what the person's providers look like now: their server
// profiles and every profile row of their devices, as the page shows them.
type providerView struct {
	devices  map[string]store.DeviceProjection
	profiles []store.ProfileDefinition
	rows     []store.AgentProfileProjection
}

func (s *Server) providerView(ctx context.Context, m providerManager) (providerView, error) {
	allDevices, err := s.store.ListDevices(ctx)
	if err != nil {
		return providerView{}, err
	}
	view := providerView{devices: map[string]store.DeviceProjection{}}
	devices := []store.DeviceProjection{}
	for _, device := range allDevices {
		if m.owned[device.ID] {
			view.devices[device.ID] = device
			devices = append(devices, device)
		}
	}
	reported, err := s.store.ListAgentProfiles(ctx, "")
	if err != nil {
		return providerView{}, err
	}
	rows := []store.AgentProfileProjection{}
	for _, row := range reported {
		if m.owned[row.DeviceID] {
			rows = append(rows, row)
		}
	}
	allProfiles, err := s.store.ListProfiles(ctx)
	if err != nil {
		return providerView{}, err
	}
	for _, profile := range allProfiles {
		if profile.OwnerUserID == m.userID {
			view.profiles = append(view.profiles, profile)
		}
	}
	view.profiles = s.overlayProfileCredentials(ctx, view.profiles)
	bindings, err := s.store.ListDeviceProfiles(ctx, "")
	if err != nil {
		return providerView{}, err
	}
	view.rows, _, err = s.serverProfileProjections(ctx, store.WorkspaceProjection{}, devices, view.profiles,
		bindings, s.overlayServerCredential(ctx, rows), nil)
	return view, err
}

// mcpProvider is one provider as the tools answer it.
type mcpProvider struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Runtime string `json:"runtime"`
	Label   string `json:"label"`
	BaseURL string `json:"baseUrl,omitempty"`
	// Model and Effort: an API endpoint's defaults (per device for the others).
	Model      string   `json:"model,omitempty"`
	Effort     string   `json:"effort,omitempty"`
	Models     []string `json:"models,omitempty"`
	ModelCount int      `json:"modelCount,omitempty"`
	// KeySet says whether the server holds a key for an API endpoint; the key
	// itself is never answered.
	KeySet *bool `json:"keySet,omitempty"`
	// PromotedTo names the API endpoint a discovered provider became.
	PromotedTo string              `json:"promotedTo,omitempty"`
	ManagedIn  string              `json:"managedIn,omitempty"`
	Devices    []mcpProviderDevice `json:"devices"`
}

// mcpProviderDevice is a provider on one device: an API endpoint where it is
// assigned, the others where the device reports them.
type mcpProviderDevice struct {
	DeviceID string                   `json:"deviceId"`
	Device   string                   `json:"device"`
	Online   bool                     `json:"online"`
	Status   string                   `json:"status"`
	Detail   string                   `json:"detail,omitempty"`
	Model    string                   `json:"model,omitempty"`
	Effort   string                   `json:"effort,omitempty"`
	Check    *store.AgentProfileCheck `json:"check,omitempty"`
}

func profileEffort(runtime, claudeEffort, codexEffort string) string {
	if runtime == "codex" {
		return codexEffort
	}
	return claudeEffort
}

func capModels(provider *mcpProvider, models []string) {
	provider.ModelCount = len(models)
	if len(models) > providerModelsShown {
		models = models[:providerModelsShown]
	}
	provider.Models = models
}

// rowKind is the kind of provider a device's profile row is, "" for rows
// that are no provider of their own (a server profile's row, env, command).
func rowKind(row store.AgentProfileProjection) string {
	if row.Origin == profileOriginServer {
		return ""
	}
	switch row.ConnectionType {
	case "local_login":
		return providerKindSubscription
	case "external":
		return providerKindEnvironment
	case "anthropic_compatible", "openai_compatible":
		return providerKindDiscovered
	}
	return ""
}

func (v providerView) deviceEntry(row store.AgentProfileProjection, withDefaults bool) mcpProviderDevice {
	device := v.devices[row.DeviceID]
	entry := mcpProviderDevice{
		DeviceID: row.DeviceID,
		Device:   device.Label,
		Online:   device.Status == deviceStatusConnected,
		Status:   row.Status,
		Detail:   row.StatusDetail,
		Check:    row.Check,
	}
	if withDefaults {
		entry.Model = row.Model
		entry.Effort = profileEffort(row.Runtime, row.ClaudeEffort, row.CodexReasoningEffort)
	}
	return entry
}

// providers lists every provider of the view, API endpoints first by kind
// order, then by label.
func (v providerView) providers() []mcpProvider {
	items := []mcpProvider{}
	for _, profile := range v.profiles {
		keySet := profile.HasCredential
		item := mcpProvider{
			ID: profile.ID, Kind: providerKindAPI, Runtime: profile.Runtime, Label: profile.Label,
			BaseURL: profile.BaseURL, Model: profile.Model, KeySet: &keySet,
			Effort:  profileEffort(profile.Runtime, profile.ClaudeEffort, profile.CodexReasoningEffort),
			Devices: []mcpProviderDevice{},
		}
		capModels(&item, profile.Models)
		for _, row := range v.rows {
			if row.Origin == profileOriginServer && row.ID == profile.ID {
				item.Devices = append(item.Devices, v.deviceEntry(row, false))
			}
		}
		items = append(items, item)
	}
	grouped := map[string]int{}
	for _, row := range v.rows {
		kind := rowKind(row)
		if kind == "" {
			continue
		}
		key := kind + "\x00" + row.Runtime + "\x00" + row.ID
		index, ok := grouped[key]
		if !ok {
			item := mcpProvider{ID: row.ID, Kind: kind, Runtime: row.Runtime, Label: row.Label, Devices: []mcpProviderDevice{}}
			switch kind {
			case providerKindEnvironment:
				item.ManagedIn = "Connectors"
			case providerKindDiscovered:
				item.BaseURL = row.BaseURL
				capModels(&item, row.Models)
			}
			items = append(items, item)
			index = len(items) - 1
			grouped[key] = index
		}
		if row.PromotedProfileID != "" {
			items[index].PromotedTo = row.PromotedProfileID
		}
		items[index].Devices = append(items[index].Devices, v.deviceEntry(row, kind != providerKindDiscovered))
	}
	for i := range items {
		sort.SliceStable(items[i].Devices, func(a, b int) bool {
			return items[i].Devices[a].Device < items[i].Devices[b].Device
		})
	}
	sort.SliceStable(items, func(a, b int) bool {
		if items[a].Kind != items[b].Kind {
			return providerKindOrder[items[a].Kind] < providerKindOrder[items[b].Kind]
		}
		return strings.ToLower(items[a].Label) < strings.ToLower(items[b].Label)
	})
	return items
}

func (v providerView) provider(kind, id string) (mcpProvider, bool) {
	for _, item := range v.providers() {
		if item.ID == id && (kind == "" || item.Kind == kind) {
			return item, true
		}
	}
	return mcpProvider{}, false
}

func (s *Server) listModelProvidersForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	m, err := s.providerManagerFor(ctx, call.actor)
	if err != nil {
		return "", err
	}
	view, err := s.providerView(ctx, m)
	if err != nil {
		return "", err
	}
	runtime, kind := mcpArgString(call.args, "runtime"), mcpArgString(call.args, "kind")
	deviceID, providerID := mcpArgString(call.args, "deviceId"), mcpArgString(call.args, "providerId")
	if deviceID != "" {
		if err := m.device(deviceID); err != nil {
			return "", err
		}
	}
	matched := []mcpProvider{}
	for _, item := range view.providers() {
		if (runtime != "" && item.Runtime != runtime) || (kind != "" && item.Kind != kind) ||
			(providerID != "" && item.ID != providerID) {
			continue
		}
		if deviceID != "" {
			devices := []mcpProviderDevice{}
			for _, device := range item.Devices {
				if device.DeviceID == deviceID {
					devices = append(devices, device)
				}
			}
			if len(devices) == 0 {
				continue
			}
			item.Devices = devices
		}
		matched = append(matched, item)
	}
	offset := max(mcpArgNumber(call.args, "offset", 0), 0)
	limit := min(max(mcpArgNumber(call.args, "limit", defaultProviderPage), 1), maxProviderPage)
	page := []mcpProvider{}
	if offset < len(matched) {
		page = matched[offset:min(offset+limit, len(matched))]
	}
	devices := []map[string]any{}
	for _, device := range view.devices {
		devices = append(devices, map[string]any{"deviceId": device.ID, "device": device.Label, "online": device.Status == deviceStatusConnected})
	}
	sort.Slice(devices, func(a, b int) bool { return devices[a]["device"].(string) < devices[b]["device"].(string) })
	answer := map[string]any{"total": len(matched), "offset": offset, "providers": page}
	if offset+len(page) < len(matched) {
		answer["nextOffset"] = offset + len(page)
	}
	if offset == 0 {
		answer["yourDevices"] = devices
	}
	return encodeJSON(answer)
}

// saveModelProviderForMCP creates or updates an API endpoint, the way the
// page's editor does, and sets the devices it applies to.
func (s *Server) saveModelProviderForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	m, err := s.providerManagerFor(ctx, call.actor)
	if err != nil {
		return "", err
	}
	args := call.args
	present := func(key string) bool { _, ok := args[key]; return ok }
	providerID := mcpArgString(args, "providerId")
	var input store.SaveProfileInput
	if providerID != "" {
		current, owns, err := s.ownedProfile(ctx, m, providerID)
		if err != nil {
			return "", err
		}
		if !owns {
			return "", &statusError{http.StatusNotFound, errors.New("API endpoint not found: " + providerID + " (save_model_provider edits API endpoints you own; a subscription's or environment's defaults are set with set_model_defaults)")}
		}
		if runtime := mcpArgString(args, "runtime"); runtime != "" && runtime != current.Runtime {
			return "", &statusError{http.StatusBadRequest, errors.New("runtime cannot change; create a new provider instead")}
		}
		input = profileSaveInput(current)
	} else {
		input = store.SaveProfileInput{Runtime: mcpArgString(args, "runtime"), AuthMode: "custom"}
		if input.Runtime == "" {
			return "", &statusError{http.StatusBadRequest, errors.New("runtime is required for a new provider: claude (Anthropic-compatible) or codex (OpenAI-compatible)")}
		}
	}
	if present("label") {
		input.Label = mcpArgString(args, "label")
	}
	if present("baseUrl") {
		input.BaseURL = mcpArgString(args, "baseUrl")
	}
	if present("model") {
		input.Model = mcpArgString(args, "model")
	}
	if present("models") {
		input.Models = mcpArgList(args, "models")
	}
	if present("effort") {
		effort := mcpArgString(args, "effort")
		if err := checkEffort(input.Runtime, effort); err != nil {
			return "", err
		}
		if input.Runtime == "codex" {
			input.CodexReasoningEffort = effort
		} else {
			input.ClaudeEffort = effort
		}
	}
	apiKey, clearKey := strings.TrimSpace(mcpArgString(args, "apiKey")), mcpArgBool(args, "clearApiKey")
	if apiKey != "" && clearKey {
		return "", &statusError{http.StatusBadRequest, errors.New("give apiKey or clearApiKey, not both")}
	}
	input.APIKey = apiKey
	var deviceIDs []string
	if present("deviceIds") {
		deviceIDs = mcpArgList(args, "deviceIds")
		for _, deviceID := range deviceIDs {
			if err := m.device(deviceID); err != nil {
				return "", err
			}
		}
	}
	var profile store.ProfileDefinition
	if providerID == "" {
		profile, err = s.createServerProfile(ctx, m.userID, input)
	} else {
		profile, err = s.updateServerProfile(ctx, providerID, input)
	}
	if err != nil {
		return "", err
	}
	if clearKey {
		if _, err := s.clearServerProfileCredential(ctx, profile.ID); err != nil {
			return "", err
		}
	}
	if present("deviceIds") {
		if err := s.assignProfileToDevices(ctx, m, profile.ID, deviceIDs); err != nil {
			return "", fmt.Errorf("%s was saved, but its devices were not all set: %w", profile.ID, err)
		}
	}
	return s.providerAnswer(ctx, m, providerKindAPI, profile.ID)
}

func checkEffort(runtime, effort string) error {
	allowed := []string{"low", "medium", "high", "xhigh", "max"}
	if runtime == "codex" {
		allowed = []string{"minimal", "low", "medium", "high", "xhigh"}
	}
	if effort == "" || slices.Contains(allowed, effort) {
		return nil
	}
	return &statusError{http.StatusBadRequest, fmt.Errorf("effort for %s is one of %s, or \"\" for the runtime's default", runtime, strings.Join(allowed, ", "))}
}

// assignProfileToDevices makes deviceIDs exactly the person's devices that
// run the profile, changing each device's set the way the page does.
func (s *Server) assignProfileToDevices(ctx context.Context, m providerManager, profileID string, deviceIDs []string) error {
	want := map[string]bool{}
	for _, deviceID := range deviceIDs {
		want[deviceID] = true
	}
	bindings, err := s.store.ListDeviceProfiles(ctx, "")
	if err != nil {
		return err
	}
	enabled := map[string][]string{}
	for _, binding := range bindings {
		if binding.Enabled {
			enabled[binding.DeviceID] = append(enabled[binding.DeviceID], binding.ProfileID)
		}
	}
	owned := make([]string, 0, len(m.owned))
	for deviceID := range m.owned {
		owned = append(owned, deviceID)
	}
	sort.Strings(owned)
	for _, deviceID := range owned {
		current := enabled[deviceID]
		has := slices.Contains(current, profileID)
		switch {
		case want[deviceID] && !has:
			_, err = s.setDeviceProfiles(ctx, deviceID, append(slices.Clone(current), profileID))
		case !want[deviceID] && has:
			_, err = s.setDeviceProfiles(ctx, deviceID, slices.DeleteFunc(slices.Clone(current), func(id string) bool { return id == profileID }))
		default:
			continue
		}
		if err != nil {
			return fmt.Errorf("%s: %w", deviceID, err)
		}
	}
	return nil
}

// providerAnswer is one provider as list_model_providers shows it.
func (s *Server) providerAnswer(ctx context.Context, m providerManager, kind, id string) (string, error) {
	view, err := s.providerView(ctx, m)
	if err != nil {
		return "", err
	}
	item, ok := view.provider(kind, id)
	if !ok {
		return "", &statusError{http.StatusNotFound, errors.New("provider not found: " + id)}
	}
	return encodeJSON(item)
}

func (s *Server) deleteModelProviderForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	m, err := s.providerManagerFor(ctx, call.actor)
	if err != nil {
		return "", err
	}
	providerID := mcpArgString(call.args, "providerId")
	if _, owns, err := s.ownedProfile(ctx, m, providerID); err != nil {
		return "", err
	} else if !owns {
		return "", &statusError{http.StatusNotFound, errors.New("API endpoint not found: " + providerID + " (only API endpoints you own are deleted here; subscriptions sign out and environments are removed on their device or in Connectors)")}
	}
	profile, err := s.deleteServerProfile(ctx, providerID)
	if err != nil {
		return "", err
	}
	return encodeJSON(map[string]any{"deleted": profile.ID, "label": profile.Label, "keyDeleted": profile.HasCredential})
}

// checkModelProviderForMCP runs the check the page offers for the
// provider's kind on one device: an API endpoint's or a launch
// environment's short conversation through the device's agent SDK, or a
// subscription's login check. Discovered endpoints are checked by their
// device on their own; their last result is answered.
func (s *Server) checkModelProviderForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	m, err := s.providerManagerFor(ctx, call.actor)
	if err != nil {
		return "", err
	}
	providerID, deviceID := mcpArgString(call.args, "providerId"), mcpArgString(call.args, "deviceId")
	if err := m.device(deviceID); err != nil {
		return "", err
	}
	if _, owns, err := s.ownedProfile(ctx, m, providerID); err != nil {
		return "", err
	} else if owns {
		check, err := s.checkServerProfile(ctx, providerID, deviceID)
		if err != nil {
			return "", err
		}
		return encodeJSON(map[string]any{"providerId": providerID, "kind": providerKindAPI, "deviceId": deviceID, "check": check})
	}
	row, err := s.deviceProfileProjection(ctx, deviceID, providerID)
	if errors.Is(err, store.ErrNotFound) {
		return "", &statusError{http.StatusNotFound, errors.New("provider not found on this device: " + providerID)}
	}
	if err != nil {
		return "", err
	}
	switch rowKind(row) {
	case providerKindEnvironment:
		value, err := s.hub.externalConnectionRequest(ctx, deviceID, wsCheckExternalConnectionType, providerID, externalConnectionCheckTimeout)
		if err == nil && value.Result == nil {
			err = errors.New("the device did not report a check result")
		}
		if err != nil {
			return "", err
		}
		s.projectionsChanged("", connectionFields...)
		return encodeJSON(map[string]any{"providerId": providerID, "kind": providerKindEnvironment, "deviceId": deviceID, "check": value.Result})
	case providerKindSubscription:
		if err := s.checkDeviceAccountTarget(ctx, deviceID, row.Runtime); err != nil {
			return "", err
		}
		inspection, err := s.hub.InspectNativeAccount(ctx, deviceID, row.Runtime, "")
		if errors.Is(err, store.ErrNotFound) {
			err = &statusError{http.StatusConflict, errors.New("device disconnected")}
		}
		if err != nil {
			return "", err
		}
		return encodeJSON(map[string]any{"providerId": providerID, "kind": providerKindSubscription, "deviceId": deviceID,
			"login": map[string]any{"status": inspection.Status, "account": inspection.AccountLabel, "plan": inspection.Plan,
				"message": inspection.Message, "checkedAt": inspection.CheckedAt}})
	case providerKindDiscovered:
		return encodeJSON(map[string]any{"providerId": providerID, "kind": providerKindDiscovered, "deviceId": deviceID,
			"check": row.Check, "note": "its device checks a provider it finds on its own; this is the last result"})
	}
	return "", &statusError{http.StatusBadRequest, errors.New(providerID + " is not a model provider that can be checked")}
}

// setModelDefaultsForMCP saves a subscription's or launch environment's
// default model and effort on one device, as the page's Defaults… does.
func (s *Server) setModelDefaultsForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	m, err := s.providerManagerFor(ctx, call.actor)
	if err != nil {
		return "", err
	}
	args := call.args
	providerID, deviceID := mcpArgString(args, "providerId"), mcpArgString(args, "deviceId")
	if err := m.device(deviceID); err != nil {
		return "", err
	}
	if _, owns, err := s.ownedProfile(ctx, m, providerID); err != nil {
		return "", err
	} else if owns {
		return "", &statusError{http.StatusBadRequest, errors.New("an API endpoint's defaults hold on every device: set them with save_model_provider (model, effort)")}
	}
	row, err := s.deviceProfileProjection(ctx, deviceID, providerID)
	if errors.Is(err, store.ErrNotFound) {
		return "", &statusError{http.StatusNotFound, errors.New("provider not found on this device: " + providerID)}
	}
	if err != nil {
		return "", err
	}
	kind := rowKind(row)
	if kind != providerKindSubscription && kind != providerKindEnvironment {
		return "", &statusError{http.StatusBadRequest, errors.New("defaults are set here for a subscription or a launch environment on a device")}
	}
	// What the page's Defaults… form sends, from the row as the device has it.
	input := store.CreateAgentProfileInput{
		ID: row.ID, DeviceID: deviceID, ConfigScope: "device", ConnectionType: row.ConnectionType,
		Runtime: row.Runtime, Label: row.Label, Model: row.Model,
		ClaudeEffort: row.ClaudeEffort, ClaudePermissionMode: row.ClaudePermissionMode,
		CodexReasoningEffort: row.CodexReasoningEffort, CodexSandboxMode: row.CodexSandboxMode,
		CodexApprovalPolicy: row.CodexApprovalPolicy, CodexSpeed: row.CodexSpeed,
		ContextWindows: row.ContextWindows, PromptPrefix: row.PromptPrefix,
	}
	if _, ok := args["model"]; ok {
		input.Model = mcpArgString(args, "model")
	}
	if _, ok := args["effort"]; ok {
		effort := mcpArgString(args, "effort")
		if err := checkEffort(row.Runtime, effort); err != nil {
			return "", err
		}
		if row.Runtime == "codex" {
			input.CodexReasoningEffort = effort
		} else {
			input.ClaudeEffort = effort
		}
	}
	if message := checkDeviceProfileInput(&input); message != "" {
		return "", &statusError{http.StatusBadRequest, errors.New(message)}
	}
	if _, err := s.saveDeviceProfile(ctx, input); err != nil {
		return "", err
	}
	return s.providerAnswer(ctx, m, kind, providerID)
}

// signInSubscriptionForMCP drives a subscription's sign-in on a device the
// way the page's Sign in dialog does: the device's CLI signs in; the agent
// only hands the person the link and code and passes back the code the
// person pastes.
func (s *Server) signInSubscriptionForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	m, err := s.providerManagerFor(ctx, call.actor)
	if err != nil {
		return "", err
	}
	args := call.args
	deviceID, runtime := mcpArgString(args, "deviceId"), mcpArgString(args, "runtime")
	if err := m.device(deviceID); err != nil {
		return "", err
	}
	if err := s.checkDeviceAccountTarget(ctx, deviceID, runtime); err != nil {
		return "", err
	}
	actions := map[string]store.NativeSignInAction{
		"start": store.NativeSignInActionBegin, "status": store.NativeSignInActionPoll,
		"code": store.NativeSignInActionInput, "cancel": store.NativeSignInActionDismiss,
	}
	action, ok := actions[mcpArgString(args, "action")]
	if !ok {
		return "", &statusError{http.StatusBadRequest, errors.New("action is start, status, code or cancel")}
	}
	// One sign-in per caller, device and runtime: starting again answers the
	// one already running.
	requestID := "mcp:" + call.actor.Identity.SessionID
	if !call.actor.Agent() {
		requestID = "mcp:" + m.userID
	}
	step, err := s.nativeSignInStep(ctx, m.userID, deviceID, runtime, action, store.NativeSignInInput{
		RequestID: requestID, OperationID: mcpArgString(args, "operationId"), Code: mcpArgString(args, "code"),
	})
	if errors.Is(err, store.ErrNotFound) {
		err = &statusError{http.StatusConflict, errors.New("device disconnected")}
	}
	if err != nil {
		return "", err
	}
	return encodeJSON(step)
}
