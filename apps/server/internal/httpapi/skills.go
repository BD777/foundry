package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"path"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/builtinskills"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// builtinSkillProjections lists Foundry's built-in skills for the web app.
func builtinSkillProjections() []store.BuiltinSkill {
	all := builtinskills.All()
	out := make([]store.BuiltinSkill, 0, len(all))
	for _, skill := range all {
		out = append(out, store.BuiltinSkill{
			Runtime:     skill.Runtime,
			Name:        skill.Name,
			Description: skill.Description,
			Source:      skill.Source,
		})
	}
	return out
}

// withBuiltinSkills adds the built-in skills of a session's agent to its
// workspace selection. A selected skill of the same name gives way: one
// invocation name must mean one skill.
func withBuiltinSkills(refs []store.SessionSkillRef, runtime string) []store.SessionSkillRef {
	builtins := builtinskills.ForRuntime(runtime)
	if len(builtins) == 0 {
		return refs
	}
	names := map[string]bool{}
	out := make([]store.SessionSkillRef, 0, len(refs)+len(builtins))
	for _, skill := range builtins {
		names[strings.ToLower(skill.Name)] = true
		out = append(out, store.SessionSkillRef{
			SkillID:      skill.ID,
			Revision:     skill.Revision,
			Name:         skill.Name,
			Checksum:     skill.Checksum,
			SourceDigest: skill.SourceDigest,
			ByteSize:     int64(len(skill.Package)),
		})
	}
	for _, ref := range refs {
		if !names[strings.ToLower(ref.Name)] {
			out = append(out, ref)
		}
	}
	return out
}

// wsScanSkillsPayload is the server -> daemon scan request. The explicit
// root list is authoritative; the daemon never persists scan configuration.
type wsScanSkillsPayload struct {
	Roots []string `json:"roots"`
	// Tools are programs library skills need; the daemon says which it has.
	Tools []string `json:"tools,omitempty"`
	// KnownDigest is the digest of the device's last answer the server
	// keeps (see keptSkillScans); the same answer comes back as Unchanged.
	KnownDigest string `json:"knownDigest,omitempty"`
}

// wsSkillsScannedPayload is the daemon's scan result. Device id is stamped by
// the hub from the connection.
type wsSkillsScannedPayload struct {
	Skills []store.DeviceSkill `json:"skills"`
	Error  string              `json:"error,omitempty"`
	// Tools answers the request's tools; an empty answer is not kept
	// (keptSkillScans), so a kept answer may have none.
	Tools map[string]bool `json:"tools,omitempty"`
	// ToolVersions are the tool versions Foundry installed on the device.
	ToolVersions map[string]string `json:"toolVersions,omitempty"`
	// Digest is the device's digest of its answer. Unchanged: the answer is
	// the one the request's KnownDigest names, and only the digest came.
	Digest    string `json:"digest,omitempty"`
	Unchanged bool   `json:"unchanged,omitempty"`
}

// keptSkillScans keeps each device's last skill scan answer, as JSON, by
// the digest the device gave it, while the server runs. A device whose
// skills did not change (the scan on every reconnect, the half-hourly one)
// answers "unchanged" instead of sending them all again: linux-dev's answer
// was ~620 KB over a 5-20 KB/s uplink. The kept answer is then stored
// exactly as if it had come again.
type keptSkillScans struct {
	mu      sync.Mutex
	answers map[string]keptSkillScan
}

type keptSkillScan struct {
	digest string
	data   []byte
}

func (k *keptSkillScans) known(deviceID string) keptSkillScan {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.answers[deviceID]
}

func (k *keptSkillScans) keep(deviceID string, answer wsSkillsScannedPayload) {
	if answer.Unchanged {
		return
	}
	data, err := json.Marshal(answer)
	if err != nil {
		return
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.answers == nil {
		k.answers = map[string]keptSkillScan{}
	}
	k.answers[deviceID] = keptSkillScan{digest: answer.Digest, data: data}
}

// scanAnswer is the device's answer to a scan, the kept one when the device
// said it is unchanged.
func scanAnswer(answer wsSkillsScannedPayload, kept keptSkillScan) (wsSkillsScannedPayload, error) {
	if !answer.Unchanged {
		return answer, nil
	}
	if kept.digest == "" || answer.Digest != kept.digest {
		return wsSkillsScannedPayload{}, errors.New("the device answered the skill scan with an answer the server does not have")
	}
	var whole wsSkillsScannedPayload
	err := json.Unmarshal(kept.data, &whole)
	return whole, err
}

// deviceToolStore records which programs skills need a device has.
type deviceToolStore interface {
	// ReplaceDeviceTools reports whether the device's answer changed.
	ReplaceDeviceTools(ctx context.Context, deviceID string, tools map[string]bool, versions map[string]string) (bool, error)
	SetDeviceToolVersion(ctx context.Context, deviceID, tool, version string) error
	ListDeviceTools(ctx context.Context, deviceID string) ([]store.DeviceTool, error)
}

// maxCheckedTools bounds how many program names one scan asks about.
const maxCheckedTools = 200

// libraryTools is every program some library skill or bundle needs.
func libraryTools(ctx context.Context, db Backend) []string {
	skills, err := db.ListPromotedSkills(ctx)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var tools []string
	for _, skill := range skills {
		for _, tool := range skill.Requires {
			if !seen[tool] && len(tools) < maxCheckedTools {
				seen[tool] = true
				tools = append(tools, tool)
			}
		}
	}
	if items, err := db.ListSkillRepositories(ctx); err == nil {
		for _, repo := range items {
			for _, tool := range repo.Tools {
				if !seen[tool.Name] && len(tools) < maxCheckedTools {
					seen[tool.Name] = true
					tools = append(tools, tool.Name)
				}
			}
		}
	}
	sort.Strings(tools)
	return tools
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
// the snapshot. An empty root list means the daemon-side defaults. changed
// reports whether the scan changed what is stored (the device's skills or
// tools); a scan that found nothing new changes nothing clients compare.
//
// A scan already running for the same device and folders is joined rather
// than started again: a click on Scan during the automatic scan on connect
// waits for that one instead of making the device scan twice.
func (h *DaemonHub) ScanDeviceSkills(ctx context.Context, deviceID string, roots []string) (skills []store.DeviceSkill, changed bool, err error) {
	key := deviceID + "\x00" + strings.Join(roots, "\x00")
	h.skillScansMu.Lock()
	if scan, running := h.skillScans[key]; running {
		h.skillScansMu.Unlock()
		select {
		case <-scan.done:
			return scan.skills, scan.changed, scan.err
		case <-ctx.Done():
			return nil, false, ctx.Err()
		}
	}
	scan := &skillScan{done: make(chan struct{})}
	if h.skillScans == nil {
		h.skillScans = map[string]*skillScan{}
	}
	h.skillScans[key] = scan
	h.skillScansMu.Unlock()
	// Shared by everyone who joined, so one caller leaving does not cancel it
	// for the rest; it still ends when the device disconnects.
	scan.skills, scan.changed, scan.err = h.scanDeviceSkills(context.WithoutCancel(ctx), deviceID, roots)
	h.skillScansMu.Lock()
	delete(h.skillScans, key)
	h.skillScansMu.Unlock()
	close(scan.done)
	return scan.skills, scan.changed, scan.err
}

// skillScan is one scan in flight; done closes when its result is set.
type skillScan struct {
	done    chan struct{}
	skills  []store.DeviceSkill
	changed bool
	err     error
}

func (h *DaemonHub) scanDeviceSkills(ctx context.Context, deviceID string, roots []string) ([]store.DeviceSkill, bool, error) {
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return nil, false, store.ErrNotFound
	}
	kept := h.skillScanAnswers.known(deviceID)
	request, err := json.Marshal(wsScanSkillsPayload{Roots: roots, Tools: libraryTools(ctx, h.store), KnownDigest: kept.digest})
	if err != nil {
		return nil, false, err
	}
	answer, err := daemonRequest[wsSkillsScannedPayload](ctx, connection, wsScanSkillsType, request)
	if err != nil {
		return nil, false, err
	}
	if answer.Error != "" {
		return nil, false, errors.New(answer.Error)
	}
	value, err := scanAnswer(answer, kept)
	if err != nil {
		return nil, false, err
	}
	skills := value.Skills
	for i := range skills {
		skills[i].DeviceID = deviceID
	}
	changed, err := h.store.ReplaceDeviceSkills(ctx, store.ReplaceDeviceSkillsInput{
		DeviceID: deviceID,
		Skills:   skills,
	})
	if err != nil {
		return nil, false, err
	}
	if value.Tools != nil {
		toolsChanged, err := h.store.ReplaceDeviceTools(ctx, deviceID, value.Tools, value.ToolVersions)
		if err != nil {
			return nil, false, err
		}
		changed = changed || toolsChanged
	}
	h.skillScanAnswers.keep(deviceID, value)
	listed, err := h.store.ListDeviceSkills(ctx, deviceID)
	return listed, changed, err
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
	paths := append([]string(nil), defaultSkillRoots...)
	if len(custom) > 0 {
		paths = paths[:0]
		for _, root := range custom {
			paths = append(paths, root.Path)
		}
	}
	// A workspace's own skill folders are a source too: a skill created or
	// changed there (say by an agent using skill-creator) is a draft that can
	// be published to the library. Sessions never see these folders directly.
	workspaces, err := s.store.ListWorkspaces(ctx)
	if err != nil {
		return nil, err
	}
	for _, workspace := range workspaces {
		if workspace.DeviceID != deviceID || workspace.LocalPath == "" {
			continue
		}
		for _, dir := range workspaceSkillDirs {
			paths = append(paths, path.Join(workspace.LocalPath, dir))
		}
	}
	return paths, nil
}

// workspaceSkillDirs are the skill folders agents read inside a project.
var workspaceSkillDirs = []string{".agents/skills", ".claude/skills", ".codex/skills"}

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
	answer := map[string]any{"roots": roots}
	// When the device last scanned, whether or not that changed its skills.
	scannedAt, err := s.store.DeviceSkillsScannedAt(r.Context(), deviceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if scannedAt != "" {
		answer["scannedAt"] = scannedAt
	}
	view, err := s.callerVisibility(r)
	answer["skills"] = view.deviceSkillUsage(skills)
	writeResult(w, answer, err)
}

// deviceSkillScanStore knows when each device last scanned its skills.
type deviceSkillScanStore interface {
	DeviceSkillsScannedAt(ctx context.Context, deviceID string) (string, error)
}

// deviceSkillRescanInterval is how often a connected device's skill folders
// are scanned again; a scan of unchanged skills only reads file metadata.
const deviceSkillRescanInterval = 30 * time.Minute

// backgroundSkillScanCapability marks a worker that scans off its main
// thread. An older worker cannot answer heartbeats while it scans, so a scan
// it did not ask for could drop its connection, and scanning again on every
// reconnect would keep it offline.
const backgroundSkillScanCapability = "background_skill_scan"

// keepDeviceSkillsScanned scans a device's skill folders when it connects and
// again every half hour while it stays connected, so its skills are listed
// without anyone pressing Scan.
func (s *Server) keepDeviceSkillsScanned(ctx context.Context, deviceID string, capabilities []string) {
	if !slices.Contains(capabilities, backgroundSkillScanCapability) {
		return
	}
	ticker := time.NewTicker(deviceSkillRescanInterval)
	defer ticker.Stop()
	for {
		if paths, err := s.scanPaths(ctx, deviceID); err != nil {
			log.Printf("skill scan of %s: %v", deviceID, err)
		} else if _, changed, err := s.hub.ScanDeviceSkills(ctx, deviceID, paths); err != nil {
			if ctx.Err() == nil {
				log.Printf("skill scan of %s: %v", deviceID, err)
			}
		} else if changed {
			s.projectionsChanged("", deviceScanFields...)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
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
	skills, changed, err := s.hub.ScanDeviceSkills(r.Context(), deviceID, paths)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusBadGateway, "device is offline; connect it to scan skills")
			return
		}
		writeResult(w, nil, err)
		return
	}
	if changed {
		s.projectionsChanged("", deviceScanFields...)
	}
	view, err := s.callerVisibility(r)
	writeResult(w, view.deviceSkillUsage(skills), err)
}

// handleSetDeviceSkillRoots writes the roots of the device in the path, the
// one the route checked the caller owns; a body naming another is refused.
func (s *Server) handleSetDeviceSkillRoots(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(r.PathValue("deviceId"))
	if deviceID == "" {
		writeError(w, http.StatusBadRequest, "device id is required")
		return
	}
	var input store.SetDeviceSkillRootsInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if body := strings.TrimSpace(input.DeviceID); body != "" && body != deviceID {
		writeError(w, http.StatusBadRequest, "deviceId does not match the device in the path")
		return
	}
	input.DeviceID = deviceID
	if err := s.store.SetDeviceSkillRoots(r.Context(), input); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.projectionsChanged("", fieldDeviceSkillRoots)
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
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	view, err := s.callerVisibility(r)
	writeResult(w, view.skillUsage(items), err)
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
	s.projectionsChanged("", skillLibraryFields...)
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
	// Foundry's own built-in skills are served from the server binary.
	if builtin, ok := builtinskills.Lookup(skillID); ok {
		if revision != 0 && revision != builtin.Revision {
			writeError(w, http.StatusNotFound, "skill package not found")
			return
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("X-Foundry-Skill-Checksum", builtin.Checksum)
		w.Header().Set("X-Foundry-Skill-Revision", strconv.Itoa(builtin.Revision))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(builtin.Package)
		return
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
	// The workspace is the one the route authorized, never one named in the
	// body: the access check covers only the path's workspace.
	input.WorkspaceID = strings.TrimSpace(r.PathValue("id"))
	if input.WorkspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}
	bindings, err := s.SetWorkspaceSkills(r.Context(), requestWorkspaceActor(r), input)
	writeResult(w, bindings, err)
}

// skillPinner is the store capability behind pinning a workspace's skill.
type skillPinner interface {
	SetWorkspaceSkillPin(ctx context.Context, workspaceID string, skillID string, revision int) error
}

// handleSetWorkspaceSkillPin holds a selected skill at one revision for the
// workspace, or with revision 0 lets it follow the latest again.
func (s *Server) handleSetWorkspaceSkillPin(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Revision int `json:"revision"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	workspaceID := strings.TrimSpace(r.PathValue("id"))
	err := s.store.SetWorkspaceSkillPin(r.Context(), workspaceID, strings.TrimSpace(r.PathValue("skillId")), input.Revision)
	if errors.Is(err, store.ErrSkillNotFound) || errors.Is(err, store.ErrSkillPackageNotFound) {
		writeError(w, http.StatusNotFound, "the workspace has no such skill or revision")
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	s.projectionsChanged(workspaceID, fieldWorkspaceSkillBindings)
	bindings, err := s.store.ListWorkspaceSkillBindings(r.Context(), workspaceID)
	writeResult(w, bindings, err)
}

func (s *Server) handleListWorkspaceSkills(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimSpace(r.PathValue("id"))
	if workspaceID == "" {
		workspaceID = strings.TrimSpace(r.URL.Query().Get("workspaceId"))
	}
	bindings, err := s.store.ListWorkspaceSkillBindings(r.Context(), workspaceID)
	writeResult(w, bindings, err)
}
