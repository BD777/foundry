package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// wsScanSkillsPayload is the server -> daemon scan request. The explicit
// root list is authoritative; the daemon never persists scan configuration.
type wsScanSkillsPayload struct {
	Roots []string `json:"roots"`
}

// wsSkillsScannedPayload is the daemon's scan result. Device id is stamped by
// the hub from the connection.
type wsSkillsScannedPayload struct {
	Skills []store.DeviceSkill `json:"skills"`
	Error  string              `json:"error,omitempty"`
}

// wsReadSkillContentPayload requests one skill directory as a zip.
type wsReadSkillContentPayload struct {
	Root    string `json:"root"`
	DirName string `json:"dirName"`
}

// wsSkillContentReadPayload returns the zip as standard base64 alongside the
// frontmatter metadata the catalog displays.
type wsSkillContentReadPayload struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	FileCount    int    `json:"fileCount"`
	ByteSize     int64  `json:"byteSize"`
	ContentB64   string `json:"contentBase64"`
	SourceDigest string `json:"sourceDigest"`
	Error        string `json:"error,omitempty"`
}

// defaultSkillRoots are the paths every device scans until the user edits the
// list. Tilde-relative because only the daemon can resolve its own home dir.
var defaultSkillRoots = []string{"~/.claude/skills", "~/.codex/skills"}

// ScanDeviceSkills asks an online daemon to scan the given roots, then stores
// the snapshot. An empty root list means the daemon-side defaults.
func (h *DaemonHub) ScanDeviceSkills(ctx context.Context, deviceID string, roots []string) ([]store.DeviceSkill, error) {
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return nil, store.ErrNotFound
	}
	request, err := json.Marshal(wsScanSkillsPayload{Roots: roots})
	if err != nil {
		return nil, err
	}
	value, err := daemonRequest[wsSkillsScannedPayload](ctx, connection, wsScanSkillsType, request)
	if err != nil {
		return nil, err
	}
	if value.Error != "" {
		return nil, errors.New(value.Error)
	}
	skills := value.Skills
	for i := range skills {
		skills[i].DeviceID = deviceID
	}
	if err := h.store.ReplaceDeviceSkills(ctx, store.ReplaceDeviceSkillsInput{
		DeviceID: deviceID,
		Skills:   skills,
	}); err != nil {
		return nil, err
	}
	return h.store.ListDeviceSkills(ctx, deviceID)
}

// ReadDeviceSkillContent fetches one skill zip from an online daemon.
func (h *DaemonHub) ReadDeviceSkillContent(ctx context.Context, deviceID string, root string, dirName string) (wsSkillContentReadPayload, error) {
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return wsSkillContentReadPayload{}, store.ErrNotFound
	}
	request, err := json.Marshal(wsReadSkillContentPayload{Root: root, DirName: dirName})
	if err != nil {
		return wsSkillContentReadPayload{}, err
	}
	value, err := daemonRequest[wsSkillContentReadPayload](ctx, connection, wsReadSkillContentType, request)
	if err != nil {
		return wsSkillContentReadPayload{}, err
	}
	if value.Error != "" {
		return wsSkillContentReadPayload{}, errors.New(value.Error)
	}
	return value, nil
}

// effectiveSkillRoots returns the list the UI shows. With no saved override
// the rows are the built-in defaults (flagged). Once the user edits, the
// saved full list is returned; rows equal to a default keep a default badge
// but remain removable like any other row.
func (s *Server) effectiveSkillRoots(ctx context.Context, deviceID string) ([]store.DeviceSkillRoot, error) {
	custom, err := s.store.ListDeviceSkillRoots(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	isDefault := map[string]bool{}
	for _, path := range defaultSkillRoots {
		isDefault[path] = true
	}
	if len(custom) == 0 {
		view := make([]store.DeviceSkillRoot, 0, len(defaultSkillRoots))
		for _, path := range defaultSkillRoots {
			view = append(view, store.DeviceSkillRoot{DeviceID: deviceID, Path: path, IsDefault: true})
		}
		return view, nil
	}
	for i := range custom {
		custom[i].IsDefault = isDefault[custom[i].Path]
	}
	return custom, nil
}

// scanPaths returns the absolute roots the daemon should scan: defaults until
// an override exists, then the override wholesale.
func (s *Server) scanPaths(ctx context.Context, deviceID string) ([]string, error) {
	custom, err := s.store.ListDeviceSkillRoots(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	if len(custom) == 0 {
		return append([]string(nil), defaultSkillRoots...), nil
	}
	paths := make([]string, 0, len(custom))
	for _, root := range custom {
		paths = append(paths, root.Path)
	}
	return paths, nil
}

func (s *Server) handleListDeviceSkills(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(r.URL.Query().Get("deviceId"))
	if deviceID == "" {
		writeError(w, http.StatusBadRequest, "deviceId is required")
		return
	}
	if !s.requireDeviceOwner(w, r, deviceID) {
		return
	}
	roots, err := s.effectiveSkillRoots(r.Context(), deviceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	skills, err := s.store.ListDeviceSkills(r.Context(), deviceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeResult(w, map[string]any{"roots": roots, "skills": skills}, nil)
}

func (s *Server) handleScanDeviceSkills(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(r.URL.Query().Get("deviceId"))
	if !s.requireDeviceOwner(w, r, deviceID) {
		return
	}
	if deviceID == "" {
		writeError(w, http.StatusBadRequest, "deviceId is required")
		return
	}
	paths, err := s.scanPaths(r.Context(), deviceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	skills, err := s.hub.ScanDeviceSkills(r.Context(), deviceID, paths)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusBadGateway, "device is offline; connect it to scan skills")
			return
		}
		writeResult(w, nil, err)
		return
	}
	s.invalidateProjections()
	writeResult(w, skills, nil)
}

func (s *Server) handleSetDeviceSkillRoots(w http.ResponseWriter, r *http.Request) {
	var input store.SetDeviceSkillRootsInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.DeviceID) == "" {
		writeError(w, http.StatusBadRequest, "deviceId is required")
		return
	}
	if err := s.store.SetDeviceSkillRoots(r.Context(), input); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.invalidateProjections()
	roots, err := s.effectiveSkillRoots(r.Context(), input.DeviceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeResult(w, roots, nil)
}

func (s *Server) handlePromoteSkill(w http.ResponseWriter, r *http.Request) {
	var input store.PromoteSkillInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceOwner(w, r, strings.TrimSpace(input.DeviceID)) {
		return
	}
	input.DeviceID = strings.TrimSpace(input.DeviceID)
	input.Root = strings.TrimSpace(input.Root)
	input.DirName = strings.TrimSpace(input.DirName)
	if input.DeviceID == "" || input.Root == "" || input.DirName == "" {
		writeError(w, http.StatusBadRequest, "deviceId, root and dirName are required")
		return
	}
	s.promoteSkillClosure(w, r, input)
}

func (s *Server) handleListPromotedSkills(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListPromotedSkills(r.Context())
	writeResult(w, items, err)
}

func (s *Server) handleDeletePromotedSkill(w http.ResponseWriter, r *http.Request) {
	err := s.store.DeletePromotedSkill(r.Context(), r.PathValue("id"))
	if err != nil {
		if errors.Is(err, store.ErrSkillNotFound) {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeResult(w, nil, err)
		return
	}
	s.invalidateProjections()
	writeResult(w, map[string]string{"id": r.PathValue("id")}, nil)
}

// handleSkillPackage serves one revision zip to a daemon, authenticated like
// the other /api routes. The daemon verifies the sha256 checksum header.
func (s *Server) handleSkillPackage(w http.ResponseWriter, r *http.Request) {
	skillID := strings.TrimSpace(r.PathValue("id"))
	revision := 0
	if raw := strings.TrimSpace(r.PathValue("revision")); raw != "" && raw != "latest" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "revision must be a positive integer or 'latest'")
			return
		}
		revision = parsed
	}
	pkg, err := s.store.GetSkillPackage(r.Context(), skillID, revision)
	if err != nil {
		if errors.Is(err, store.ErrSkillPackageNotFound) || errors.Is(err, store.ErrSkillNotFound) {
			writeError(w, http.StatusNotFound, "skill package not found")
			return
		}
		writeResult(w, nil, err)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("X-Foundry-Skill-Checksum", pkg.Checksum)
	w.Header().Set("X-Foundry-Skill-Revision", strconv.Itoa(pkg.Revision))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(pkg.Content)
}

func (s *Server) handleSetWorkspaceSkills(w http.ResponseWriter, r *http.Request) {
	var input store.SetWorkspaceSkillsInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.WorkspaceID) == "" {
		input.WorkspaceID = strings.TrimSpace(r.PathValue("id"))
	}
	if strings.TrimSpace(input.WorkspaceID) == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}
	if err := s.store.SetWorkspaceSkills(r.Context(), input); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.invalidateProjections()
	bindings, err := s.store.ListWorkspaceSkillBindings(r.Context(), input.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeResult(w, bindings, nil)
}

func (s *Server) handleListWorkspaceSkills(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimSpace(r.PathValue("id"))
	if workspaceID == "" {
		workspaceID = strings.TrimSpace(r.URL.Query().Get("workspaceId"))
	}
	bindings, err := s.store.ListWorkspaceSkillBindings(r.Context(), workspaceID)
	writeResult(w, bindings, err)
}
