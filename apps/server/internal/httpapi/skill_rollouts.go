package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A rollout moves the devices that have a bundle's tools from Foundry to
// one version of the bundle, CLI and skills together (docs/skills.md,
// Bundle 版本): first one canary device, where the version is staged,
// checked and only then made current; then the others. A canary whose
// check fails leaves every device where it was and returns the library to
// that version, paused.

// bundleRolloutCapability: the worker stages, activates and checks tool
// versions and pins them per session.
const bundleRolloutCapability = "bundle_rollout_v1"

// rolloutStepTimeout bounds one install or check on a device.
const rolloutStepTimeout = 10 * time.Minute

// rolloutInstallRetries are the waits before trying an install step again:
// a download that failed once (a release host's 5xx) usually works later.
var rolloutInstallRetries = []time.Duration{15 * time.Second, 45 * time.Second}

// errNothingToRoll: every device with the bundle's tools is on its newest
// version already, or none has them.
var errNothingToRoll = errors.New("every device with this bundle's tools is on its newest version")

// errRolloutRunning: a rollout of the bundle is under way.
var errRolloutRunning = errors.New("an update of this bundle is under way")

// rollouts serializes the work on each repository's rollout.
type rollouts struct {
	mu     sync.Mutex
	active map[string]*sync.Mutex
}

func (r *rollouts) of(repositoryID string) *sync.Mutex {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.active == nil {
		r.active = map[string]*sync.Mutex{}
	}
	lock, ok := r.active[repositoryID]
	if !ok {
		lock = &sync.Mutex{}
		r.active[repositoryID] = lock
	}
	return lock
}

// lock waits for the repository's rollout work.
func (r *rollouts) lock(repositoryID string) func() {
	lock := r.of(repositoryID)
	lock.Lock()
	return lock.Unlock
}

// tryLock takes it only when no rollout work runs: a check that applies a
// version holds repoMu, which a failing rollout waits for.
func (r *rollouts) tryLock(repositoryID string) (func(), bool) {
	lock := r.of(repositoryID)
	if !lock.TryLock() {
		return nil, false
	}
	return lock.Unlock, true
}

// wsCheckTool asks a worker to check a tool version.
type wsCheckTool struct {
	Tool             store.SkillBundleTool                `json:"tool"`
	Commands         []store.ConnectorVersionCheckCommand `json:"commands,omitempty"`
	ExternalAccounts []store.ExternalAccountMaterial      `json:"externalAccounts,omitempty"`
}

type wsToolChecked struct {
	Name    string                       `json:"name"`
	Version string                       `json:"version"`
	Steps   []store.SkillBundleCheckStep `json:"steps"`
	Error   string                       `json:"error,omitempty"`
}

// rolloutTools are the tools a version installs, as full specs.
func rolloutTools(version store.SkillBundleVersion) []store.SkillBundleTool {
	return version.Tools
}

// toolsLabel names tool versions, e.g. "feishu-cli v1.41.0".
func toolsLabel(tools map[string]string) string {
	names := make([]string, 0, len(tools))
	for name := range tools {
		names = append(names, name)
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	for _, name := range names {
		parts = append(parts, name+" "+tools[name])
	}
	return strings.Join(parts, ", ")
}

// rolloutTargets are the devices to move to version: every device with one
// of the bundle's tools from Foundry at another version.
func rolloutTargets(repo store.SkillRepository, version store.SkillBundleVersion, reported []store.DeviceTool) []store.SkillBundleRolloutDevice {
	needs := versionTools(repo, version)
	installed := installedByDevice(reported)
	devices := make([]string, 0, len(installed))
	for device := range installed {
		devices = append(devices, device)
	}
	sort.Strings(devices)
	var targets []store.SkillBundleRolloutDevice
	for _, device := range devices {
		have := bundleToolsOnDevice(repo, installed[device])
		behind := false
		for name, version := range have {
			if want, listed := needs[name]; listed && want != version {
				behind = true
			}
		}
		if behind {
			targets = append(targets, store.SkillBundleRolloutDevice{DeviceID: device, From: toolsLabel(have), State: store.RolloutDevicePending})
		}
	}
	return targets
}

// startBundleRollout starts moving a bundle's devices to its newest
// version. It answers at once; the rollout runs in the background.
func (s *Server) startBundleRollout(ctx context.Context, repositoryID, trigger string, failCheck bool) (store.SkillRepository, error) {
	unlock, ok := s.rollouts.tryLock(repositoryID)
	if !ok {
		return store.SkillRepository{}, errRolloutRunning
	}
	defer unlock()
	repo, err := s.store.GetSkillRepository(ctx, repositoryID)
	if err != nil {
		return repo, err
	}
	if repo.Mode != "bundle" || len(repo.Tools) == 0 {
		return repo, errors.New("only a bundle with tools is updated on devices")
	}
	// An unfinished rollout here is idle (its work holds the lock): it waits
	// for devices that are offline. The new one takes them over, so a device
	// that never returns does not hold the bundle back.
	versions, err := s.store.ListBundleVersions(ctx, repo.ID)
	if err != nil {
		return repo, err
	}
	if len(versions) == 0 || len(rolloutTools(versions[0])) == 0 {
		return repo, errors.New("the bundle's newest version names no tools to install")
	}
	// An automatic start (a followed version, a catch-up) never replaces a
	// rollout of the same version: it was already started, by whatever
	// read the repository first.
	if trigger == store.BundleUpdateAuto && repo.Rollout != nil && repo.Rollout.Seq == versions[0].Seq {
		return repo, errNothingToRoll
	}
	reported, err := s.store.ListDeviceTools(ctx, "")
	if err != nil {
		return repo, err
	}
	targets := rolloutTargets(repo, versions[0], reported)
	if len(targets) == 0 {
		return repo, errNothingToRoll
	}
	labels := s.deviceLabels(ctx)
	for i := range targets {
		targets[i].DeviceName = labels[targets[i].DeviceID]
	}
	rollout := &store.SkillBundleRollout{
		ID: "rol_" + uuid.NewString(), Seq: versions[0].Seq, Tag: versions[0].Tag, Trigger: trigger,
		State: store.RolloutCanary, Devices: targets, StartedAt: formatRolloutTime(time.Now()), FailCheck: failCheck,
	}
	if err := s.store.SetBundleRollout(ctx, repo.ID, rollout); err != nil {
		return repo, err
	}
	repo.Rollout = rollout
	s.projectionsChanged("", skillLibraryFields...)
	s.hub.work.Go(func() { s.runBundleRollout(context.Background(), repo.ID) })
	return repo, nil
}

func formatRolloutTime(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// rolloutRun is one pass over a rollout, with its repository and target
// version loaded.
type rolloutRun struct {
	s       *Server
	repo    store.SkillRepository
	version store.SkillBundleVersion
	rollout *store.SkillBundleRollout
}

func (r *rolloutRun) save(ctx context.Context) {
	if err := r.s.store.SetBundleRollout(ctx, r.repo.ID, r.rollout); err != nil {
		log.Printf("bundle rollout %s: save: %v", r.repo.Label, err)
	}
	r.s.projectionsChanged("", skillLibraryFields...)
}

func (r *rolloutRun) device(id string) *store.SkillBundleRolloutDevice {
	for i := range r.rollout.Devices {
		if r.rollout.Devices[i].DeviceID == id {
			return &r.rollout.Devices[i]
		}
	}
	return nil
}

// runBundleRollout takes a rollout as far as it can go now: the canary,
// then every other device that is online. It is safe to run again (after
// a restart, or when a device comes back): staged installs repeat.
func (s *Server) runBundleRollout(ctx context.Context, repositoryID string) {
	unlock := s.rollouts.lock(repositoryID)
	defer unlock()
	repo, err := s.store.GetSkillRepository(ctx, repositoryID)
	if err != nil || repo.Rollout == nil || repo.Rollout.Finished() {
		return
	}
	version, err := s.store.GetBundleVersion(ctx, repo.ID, repo.Rollout.Seq)
	if err != nil {
		log.Printf("bundle rollout %s: version %d: %v", repo.Label, repo.Rollout.Seq, err)
		return
	}
	run := &rolloutRun{s: s, repo: repo, version: version, rollout: repo.Rollout}
	canary := run.device(run.rollout.CanaryDeviceID)
	if canary == nil || canary.State != store.RolloutDeviceUpdated {
		if !run.canary(ctx) {
			return
		}
	}
	run.rollout.State = store.RolloutRolling
	run.save(ctx)
	for i := range run.rollout.Devices {
		device := &run.rollout.Devices[i]
		if device.State == store.RolloutDeviceUpdated || device.State == store.RolloutDeviceFailed {
			continue
		}
		run.update(ctx, device)
	}
	waiting := false
	for _, device := range run.rollout.Devices {
		if device.State == store.RolloutDeviceOffline || device.State == store.RolloutDevicePending {
			waiting = true
		}
	}
	if !waiting {
		run.rollout.State = store.RolloutDone
		run.rollout.FinishedAt = formatRolloutTime(time.Now())
	}
	run.save(ctx)
}

// pickCanary is the device to try the version on first: online, with a
// worker that stages and checks, preferring one whose owner has an account
// the connector's check can act with.
func (r *rolloutRun) pickCanary(ctx context.Context) *store.SkillBundleRolloutDevice {
	var best *store.SkillBundleRolloutDevice
	bestScore := -1
	for i := range r.rollout.Devices {
		device := &r.rollout.Devices[i]
		connection := r.s.hub.connectionFor(device.DeviceID)
		if connection == nil || !connection.hasCapability(bundleRolloutCapability) {
			continue
		}
		score := 0
		owner, _ := r.s.store.DeviceOwner(ctx, device.DeviceID)
		for _, tool := range rolloutTools(r.version) {
			if r.s.connectors.UsableAccount(ctx, tool.Name, owner) {
				score++
			}
		}
		if score > bestScore {
			best, bestScore = device, score
		}
	}
	return best
}

// canary stages, checks and activates the version on one device. It
// reports whether the rollout may go on to the others.
func (r *rolloutRun) canary(ctx context.Context) bool {
	canary := r.device(r.rollout.CanaryDeviceID)
	if canary == nil || r.s.hub.connectionFor(canary.DeviceID) == nil {
		canary = r.pickCanary(ctx)
	}
	if canary == nil {
		r.rollout.State = store.RolloutWaiting
		r.rollout.Error = "no device with these tools and an up-to-date worker is online; the update starts when one connects"
		r.save(ctx)
		return false
	}
	r.rollout.CanaryDeviceID, r.rollout.State, r.rollout.Error = canary.DeviceID, store.RolloutCanary, ""
	connection := r.s.hub.connectionFor(canary.DeviceID)
	canary.State, canary.Error = store.RolloutDeviceInstalling, ""
	r.save(ctx)
	if err := r.install(ctx, connection, false); err != nil {
		canary.State, canary.Error = store.RolloutDeviceFailed, err.Error()
		r.abandon(ctx, fmt.Sprintf("installing on the canary %s failed: %v", canary.DeviceName, err))
		return false
	}
	canary.State = store.RolloutDeviceChecking
	r.save(ctx)
	owner, _ := r.s.store.DeviceOwner(ctx, canary.DeviceID)
	check := r.check(ctx, connection, canary, owner, true)
	if r.rollout.FailCheck {
		check.Forced = true
		check.State = store.CheckFailed
		check.Steps = append(check.Steps, store.SkillBundleCheckStep{Name: "drill", State: store.CheckFailed, Detail: "the update was asked to fail its check (rollback drill)"})
	}
	canary.Check = &check
	if err := r.s.store.SetBundleVersionCheck(ctx, r.repo.ID, r.version.Seq, check); err != nil {
		log.Printf("bundle rollout %s: record the check: %v", r.repo.Label, err)
	}
	if check.State != store.CheckPassed {
		canary.State, canary.Error = store.RolloutDeviceFailed, failedStep(check)
		r.discard(ctx, connection)
		r.fail(ctx, canary, fmt.Sprintf("the check on the canary %s failed: %s", canary.DeviceName, failedStep(check)))
		return false
	}
	if err := r.activate(ctx, connection, canary.DeviceID); err != nil {
		canary.State, canary.Error = store.RolloutDeviceFailed, err.Error()
		r.fail(ctx, canary, fmt.Sprintf("switching the canary %s to the new version failed: %v", canary.DeviceName, err))
		return false
	}
	canary.State = store.RolloutDeviceUpdated
	r.save(ctx)
	return true
}

func failedStep(check store.SkillBundleCheck) string {
	for _, step := range check.Steps {
		if step.State == store.CheckFailed {
			if step.Detail != "" {
				return step.Name + ": " + step.Detail
			}
			return step.Name
		}
	}
	return "the check failed"
}

// update moves one other device: staged, `--version` checked, activated.
// A worker without staging installs directly (it has no session pinning
// either). A device that fails stays on its version.
func (r *rolloutRun) update(ctx context.Context, device *store.SkillBundleRolloutDevice) {
	connection := r.s.hub.connectionFor(device.DeviceID)
	if connection == nil {
		device.State = store.RolloutDeviceOffline
		r.save(ctx)
		return
	}
	device.State, device.Error = store.RolloutDeviceInstalling, ""
	r.save(ctx)
	staged := connection.hasCapability(bundleRolloutCapability)
	if err := r.install(ctx, connection, !staged); err != nil {
		device.State, device.Error = store.RolloutDeviceFailed, err.Error()
		r.save(ctx)
		return
	}
	if staged {
		device.State = store.RolloutDeviceChecking
		r.save(ctx)
		check := r.check(ctx, connection, device, "", false)
		device.Check = &check
		if check.State != store.CheckPassed {
			device.State, device.Error = store.RolloutDeviceFailed, failedStep(check)
			r.save(ctx)
			return
		}
		if err := r.activate(ctx, connection, device.DeviceID); err != nil {
			device.State, device.Error = store.RolloutDeviceFailed, err.Error()
			r.save(ctx)
			return
		}
	} else {
		r.recordInstalled(ctx, device.DeviceID)
	}
	device.State = store.RolloutDeviceUpdated
	r.save(ctx)
}

// install installs every tool of the version on a device; activate false
// stages them. A failed install is tried again after each of
// rolloutInstallRetries' waits (installing again is safe).
func (r *rolloutRun) install(ctx context.Context, connection *daemonConnection, activate bool) error {
	for _, tool := range rolloutTools(r.version) {
		err := r.toolRequest(ctx, connection, wsInstallTool{Tool: tool, Step: "install", Activate: &activate})
		for _, wait := range rolloutInstallRetries {
			if err == nil || ctx.Err() != nil {
				break
			}
			log.Printf("bundle rollout %s: installing %s %s on %s failed, trying again in %s: %v", r.repo.Label, tool.Name, tool.Version, connection.deviceID, wait, err)
			select {
			case <-ctx.Done():
			case <-time.After(wait):
			}
			err = r.toolRequest(ctx, connection, wsInstallTool{Tool: tool, Step: "install", Activate: &activate})
		}
		if err != nil {
			return fmt.Errorf("%s %s: %w", tool.Name, tool.Version, err)
		}
	}
	return nil
}

// discard deletes the staged versions that failed their check; the worker
// keeps a version that is current.
func (r *rolloutRun) discard(ctx context.Context, connection *daemonConnection) {
	for _, tool := range rolloutTools(r.version) {
		if err := r.toolRequest(ctx, connection, wsInstallTool{Tool: tool, Step: "remove"}); err != nil {
			log.Printf("bundle rollout %s: remove staged %s %s: %v", r.repo.Label, tool.Name, tool.Version, err)
		}
	}
}

// activate makes the staged versions current and records them.
func (r *rolloutRun) activate(ctx context.Context, connection *daemonConnection, deviceID string) error {
	for _, tool := range rolloutTools(r.version) {
		if err := r.toolRequest(ctx, connection, wsInstallTool{Tool: tool, Step: "activate"}); err != nil {
			return fmt.Errorf("%s %s: %w", tool.Name, tool.Version, err)
		}
	}
	r.recordInstalled(ctx, deviceID)
	return nil
}

func (r *rolloutRun) recordInstalled(ctx context.Context, deviceID string) {
	for _, tool := range rolloutTools(r.version) {
		if err := r.s.store.SetDeviceToolVersion(ctx, deviceID, tool.Name, tool.Version); err != nil {
			log.Printf("bundle rollout %s: record %s on %s: %v", r.repo.Label, tool.Name, deviceID, err)
		}
	}
	r.s.syncConnectorToolVersions(ctx)
	r.s.projectionsChanged("", fieldDeviceTools)
}

func (r *rolloutRun) toolRequest(ctx context.Context, connection *daemonConnection, payload wsInstallTool) error {
	request, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	stepCtx, cancel := context.WithTimeout(ctx, rolloutStepTimeout)
	defer cancel()
	value, err := daemonRequest[wsToolInstalled](stepCtx, connection, wsInstallToolType, request)
	if err == nil && value.Error != "" {
		err = errors.New(value.Error)
	}
	return err
}

// check runs every tool's check on a device: `--version`, and on the
// canary (withConnector) the commands of the connector the tool belongs
// to, with stand-ins for the device owner's account.
func (r *rolloutRun) check(ctx context.Context, connection *daemonConnection, device *store.SkillBundleRolloutDevice, owner string, withConnector bool) store.SkillBundleCheck {
	result := store.SkillBundleCheck{State: store.CheckPassed, DeviceID: device.DeviceID, DeviceName: device.DeviceName, Steps: []store.SkillBundleCheckStep{}}
	for _, tool := range rolloutTools(r.version) {
		request := wsCheckTool{Tool: tool}
		if withConnector {
			prepared := r.s.connectors.PrepareToolCheck(ctx, tool.Name, device.DeviceID, owner)
			defer prepared.End()
			if prepared.Skipped != "" {
				result.Steps = append(result.Steps, store.SkillBundleCheckStep{Name: tool.Name + " (" + prepared.Kind + ")", State: store.CheckSkipped, Detail: prepared.Skipped})
			} else {
				request.Commands, request.ExternalAccounts = prepared.Commands, prepared.Materials
			}
		}
		payload, err := json.Marshal(request)
		if err != nil {
			result.State = store.CheckFailed
			result.Steps = append(result.Steps, store.SkillBundleCheckStep{Name: tool.Name, State: store.CheckFailed, Detail: err.Error()})
			break
		}
		stepCtx, cancel := context.WithTimeout(ctx, rolloutStepTimeout)
		answer, err := daemonRequest[wsToolChecked](stepCtx, connection, wsCheckToolType, payload)
		cancel()
		if err == nil && answer.Error != "" {
			err = errors.New(answer.Error)
		}
		result.Steps = append(result.Steps, r.s.keptCheckSteps(tool.Name, answer.Steps)...)
		if err != nil {
			result.State = store.CheckFailed
			result.Steps = append(result.Steps, store.SkillBundleCheckStep{Name: tool.Name, State: store.CheckFailed, Detail: err.Error()})
			break
		}
		if len(answer.Steps) == 0 {
			result.State = store.CheckFailed
			result.Steps = append(result.Steps, store.SkillBundleCheckStep{Name: tool.Name, State: store.CheckFailed, Detail: "the device reported no check steps"})
			break
		}
		for _, step := range answer.Steps {
			if step.State == store.CheckFailed {
				result.State = store.CheckFailed
			}
		}
		if result.State == store.CheckFailed {
			break
		}
	}
	result.At = formatRolloutTime(time.Now())
	return result
}

// abandon ends a rollout whose canary could not install the version (its
// download kept failing): nothing moved and nothing says the version is
// bad, so the library keeps following and its devices keep their versions
// (and skills); whoever follows the repository is told, and Update tries
// again.
func (r *rolloutRun) abandon(ctx context.Context, why string) {
	r.rollout.Error = why
	r.rollout.FinishedAt = formatRolloutTime(time.Now())
	r.rollout.State = store.RolloutFailed
	r.save(ctx)
	log.Printf("bundle rollout %s to %s: %s", r.repo.Label, r.rollout.Tag, why)
}

// fail ends a rollout whose canary failed its check: every other device stays where
// it is, the library returns to the version the canary was on and stops
// following until resumed, and whoever follows the repository is told.
func (r *rolloutRun) fail(ctx context.Context, canary *store.SkillBundleRolloutDevice, why string) {
	r.rollout.Error = why
	r.rollout.FinishedAt = formatRolloutTime(time.Now())
	r.rollout.State = store.RolloutFailed
	for i := range r.rollout.Devices {
		if r.rollout.Devices[i].DeviceID != canary.DeviceID && r.rollout.Devices[i].State != store.RolloutDeviceUpdated {
			r.rollout.Devices[i].State = store.RolloutDeviceRolledBack
		}
	}
	if seq := r.fromVersion(ctx, canary.DeviceID); seq > 0 {
		r.s.repoMu.Lock()
		err := r.s.rollbackBundle(ctx, r.repo, seq)
		r.s.repoMu.Unlock()
		if err != nil {
			log.Printf("bundle rollout %s: roll back to version %d: %v", r.repo.Label, seq, err)
		} else {
			r.rollout.State = store.RolloutRolledBack
		}
	} else if err := r.s.store.SetBundlePaused(ctx, r.repo.ID, true); err != nil {
		log.Printf("bundle rollout %s: pause: %v", r.repo.Label, err)
	}
	r.save(ctx)
	log.Printf("bundle rollout %s to %s: %s", r.repo.Label, r.rollout.Tag, why)
}

// fromVersion is the recorded version the canary was on, from what it
// reported before the rollout.
func (r *rolloutRun) fromVersion(ctx context.Context, deviceID string) int {
	versions, err := r.s.store.ListBundleVersions(ctx, r.repo.ID)
	if err != nil {
		return 0
	}
	reported, err := r.s.store.ListDeviceTools(ctx, deviceID)
	if err != nil {
		return 0
	}
	version, standing, ok := bundleVersionForDevice(r.repo, versions, installedByDevice(reported)[deviceID])
	if !ok || standing.State == store.DeviceBundleUnknown || version.Seq == r.version.Seq {
		return 0
	}
	return version.Seq
}

// resumeBundleRollouts takes up unfinished rollouts, e.g. after a restart,
// and starts the ones automatic bundles still owe their devices.
func (s *Server) resumeBundleRollouts(ctx context.Context) {
	items, err := s.store.ListSkillRepositories(ctx)
	if err != nil {
		return
	}
	for _, repo := range items {
		if repo.Rollout != nil && !repo.Rollout.Finished() {
			id := repo.ID
			s.hub.work.Go(func() { s.runBundleRollout(ctx, id) })
		}
	}
	s.hub.work.Go(func() { s.catchUpAutomaticRollouts(ctx, items) })
}

// bundleRolloutsOnConnect: a device that comes back joins the rollouts
// that wait for it (as the canary, or to be updated), and may be the first
// device an automatic bundle's owed rollout can start on.
func (s *Server) bundleRolloutsOnConnect(ctx context.Context, deviceID string) {
	items, err := s.store.ListSkillRepositories(ctx)
	if err != nil {
		return
	}
	for _, repo := range items {
		if repo.Rollout == nil || repo.Rollout.Finished() {
			continue
		}
		for _, device := range repo.Rollout.Devices {
			if device.DeviceID == deviceID {
				s.runBundleRollout(context.Background(), repo.ID)
				break
			}
		}
	}
	s.catchUpAutomaticRollouts(ctx, items)
}

// catchUpAutomaticRollouts starts a rollout for each automatic bundle whose
// newest version was never rolled out: one followed before its devices
// could be moved (a library already ahead of its CLIs), or while no rollout
// could start. A version that was rolled out (also when a device failed),
// or rolled back and paused, is not tried again on its own.
func (s *Server) catchUpAutomaticRollouts(ctx context.Context, items []store.SkillRepository) {
	for _, repo := range items {
		if repo.Mode != "bundle" || len(repo.Tools) == 0 || repo.Paused || repo.UpdatePolicy == store.BundleUpdateManual {
			continue
		}
		versions, err := s.store.ListBundleVersions(ctx, repo.ID)
		if err != nil || len(versions) == 0 || len(rolloutTools(versions[0])) == 0 {
			continue
		}
		if repo.Rollout != nil && repo.Rollout.Seq == versions[0].Seq {
			continue
		}
		s.startAutomaticRollout(ctx, repo)
	}
}

// startAutomaticRollout follows a newly applied version onto the devices
// when the bundle updates automatically.
func (s *Server) startAutomaticRollout(ctx context.Context, repo store.SkillRepository) {
	if repo.Mode != "bundle" || repo.Paused || repo.UpdatePolicy == store.BundleUpdateManual {
		return
	}
	if _, err := s.startBundleRollout(ctx, repo.ID, store.BundleUpdateAuto, false); err != nil && !errors.Is(err, errNothingToRoll) && !errors.Is(err, errRolloutRunning) {
		log.Printf("bundle rollout %s: %v", repo.Label, err)
	}
}

// handleUpdateSkillBundle moves a bundle's devices to its newest version
// now (manual updates, or a retry). failCheck is a rollback drill.
func (s *Server) handleUpdateSkillBundle(w http.ResponseWriter, r *http.Request) {
	var input struct {
		FailCheck bool `json:"failCheck"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	repo, ok := s.loadSkillRepository(w, r)
	if !ok {
		return
	}
	updated, err := s.startBundleRollout(r.Context(), repo.ID, store.BundleUpdateManual, input.FailCheck)
	if errors.Is(err, errNothingToRoll) || errors.Is(err, errRolloutRunning) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeResult(w, s.withFetchState(updated)[0], nil)
}

// handleSetSkillBundleUpdatePolicy switches a bundle between automatic and
// manual updates.
func (s *Server) handleSetSkillBundleUpdatePolicy(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Policy string `json:"policy"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.Policy != store.BundleUpdateAuto && input.Policy != store.BundleUpdateManual {
		writeError(w, http.StatusBadRequest, `policy must be "auto" or "manual"`)
		return
	}
	repo, ok := s.loadSkillRepository(w, r)
	if !ok {
		return
	}
	if err := s.store.SetBundleUpdatePolicy(r.Context(), repo.ID, input.Policy); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.projectionsChanged("", skillLibraryFields...)
	updated, err := s.store.GetSkillRepository(r.Context(), repo.ID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if input.Policy == store.BundleUpdateAuto {
		// Automatic from now: a version its devices are owed goes out.
		s.catchUpAutomaticRollouts(r.Context(), []store.SkillRepository{updated})
		if updated, err = s.store.GetSkillRepository(r.Context(), repo.ID); err != nil {
			writeResult(w, nil, err)
			return
		}
	}
	writeResult(w, s.withFetchState(updated)[0], nil)
}
