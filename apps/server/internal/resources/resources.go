// Package resources keeps the inventory of what devices offer sessions:
// browsers, the macOS desktop, simulators, phones, GPUs, container
// runtimes, toolchains, account names, disk space. Workers detect instances
// and report whole snapshots (store.ResourcesReport); the Service
// reconciles each snapshot against what the source had, gives every
// instance a stable id and marks what disappeared (gone) or cannot be
// reached (offline). Instances of a detector that failed keep their last
// known values, marked stale.
//
// Leases (leases.go, lease_*.go) decide who holds an instance and let
// operations on it through; they key on Instance.ID, which stays the same
// across rescans, reconnects and server restarts.
//
// Storage is store.ResourceStore (sqlitestore/resources.go); the package
// decides, the store only keeps what it decided.
package resources

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Bounds on one report; a report past them is cut, not refused, so one
// runaway detector cannot hide the rest.
const (
	MaxInstancesPerReport = 500
	maxTextLength         = 512
	maxDetails            = 32
	maxBackends           = 8
	maxDetectorErrors     = 64
)

// GoneRetention is how long an instance stays listed (on request) after
// it was last seen; older gone instances are deleted.
const GoneRetention = 30 * 24 * time.Hour

// legacyDetector names instances converted from a registration's
// device.resources (workers before resources_v1).
const legacyDetector = "registration@0"

// Reasons the server gives for states it decides itself.
const (
	reasonGone    = "No longer detected on its device."
	reasonOffline = "Its device is offline; showing what it last reported."
)

// ErrNoSource: a report or change names no source.
var ErrNoSource = errors.New("resource source id is required")

// InstanceID is the stable id of the instance with key at sourceID:
// "res_" and the first 20 hex digits of sha256(sourceID NUL key).
func InstanceID(sourceID, key string) string {
	sum := sha256.Sum256([]byte(sourceID + "\x00" + key))
	return "res_" + hex.EncodeToString(sum[:])[:20]
}

// Service reconciles reports into the inventory and lists it. Writes are
// serialized: a source's report and its going offline never interleave.
type Service struct {
	store store.ResourceStore
	mu    sync.Mutex
	// Now is the clock; tests set it.
	Now func() time.Time
	// Online reports whether a source is connected now. Listing shows the
	// instances of a source that is not as offline, which also covers a
	// server that restarted while devices were away. Nil: all online.
	Online func(sourceID string) bool
	// Changed is told the source whose listing changed (an event for
	// browsers); nil to tell no one.
	Changed func(sourceID string)
	// leases, when set (NewLeases), are shown on the instances listed and
	// told what reports change.
	leases *Leases
}

// NewService is a service over st.
func NewService(st store.ResourceStore) *Service {
	return &Service{store: st, Now: time.Now}
}

// Report applies a source's full snapshot. It returns whether anything a
// reader sees changed (when a source was last seen does not count).
func (s *Service) Report(ctx context.Context, source store.ResourceSource, report store.ResourcesReport) (bool, error) {
	if strings.TrimSpace(source.ID) == "" {
		return false, ErrNoSource
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.Now().UTC()
	existing, err := s.store.ListResourceInstances(ctx, store.ResourceFilter{SourceID: source.ID, IncludeGone: true})
	if err != nil {
		return false, err
	}
	previous, err := s.sourceStatus(ctx, source.ID)
	if err != nil {
		return false, err
	}
	report = Sanitize(report)
	instances := Reconcile(existing, source, report, now)
	status := store.ResourceSourceStatus{
		Kind: source.Kind, ID: source.ID, Label: source.Label, Online: true,
		ScannerVersion: report.ScannerVersion, LastReportAt: formatTime(now),
		DetectorErrors: report.DetectorErrors,
	}
	if err := s.store.ReplaceSourceResources(ctx, status, instances); err != nil {
		return false, err
	}
	if _, err := s.store.DeleteGoneResources(ctx, now.Add(-GoneRetention)); err != nil {
		return false, err
	}
	changed := !sameListing(existing, instances) || previous == nil || !sameSource(*previous, status)
	if changed && s.Changed != nil {
		s.Changed(source.ID)
	}
	if changed && s.leases != nil {
		// After this report's write: what went gone loses its lease, what
		// became ready goes to whoever waits.
		defer func() {
			if err := s.leases.InventoryChanged(ctx, source.ID); err != nil {
				log.Printf("resources: leases after %s's report: %v", source.ID, err)
			}
		}()
	}
	return changed, nil
}

// ReportLegacy applies the resources a worker before resources_v1 lists in
// its registration: browsers and macOS screen control, listed only.
func (s *Service) ReportLegacy(ctx context.Context, source store.ResourceSource, resources []store.DeviceResource) (bool, error) {
	return s.Report(ctx, source, LegacyReport(resources, s.Now().UTC()))
}

// SourceOffline marks a source's instances offline: its device
// disconnected. Their last known values stay; the next report decides
// again.
func (s *Service) SourceOffline(ctx context.Context, sourceID string) error {
	if strings.TrimSpace(sourceID) == "" {
		return ErrNoSource
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	status, err := s.sourceStatus(ctx, sourceID)
	if err != nil || status == nil {
		return err
	}
	instances, err := s.store.ListResourceInstances(ctx, store.ResourceFilter{SourceID: sourceID, IncludeGone: true})
	if err != nil {
		return err
	}
	for index := range instances {
		instances[index] = offline(instances[index])
	}
	status.Online = false
	if err := s.store.ReplaceSourceResources(ctx, *status, instances); err != nil {
		return err
	}
	if s.Changed != nil {
		s.Changed(sourceID)
	}
	return nil
}

// List lists the inventory as filter narrows it, with every source; the
// instances of a source that is not online read as offline, held ones show
// their holder.
func (s *Service) List(ctx context.Context, filter store.ResourceFilter) (store.ResourceList, error) {
	list, err := s.listWithSources(ctx, filter)
	if err != nil || s.leases == nil {
		return list, err
	}
	return list, s.leases.overlay(ctx, list.Instances)
}

// list lists instances as List does, without leases.
func (s *Service) list(ctx context.Context, filter store.ResourceFilter) ([]store.ResourceInstance, error) {
	list, err := s.listWithSources(ctx, filter)
	return list.Instances, err
}

func (s *Service) listWithSources(ctx context.Context, filter store.ResourceFilter) (store.ResourceList, error) {
	instances, err := s.store.ListResourceInstances(ctx, filter)
	if err != nil {
		return store.ResourceList{}, err
	}
	sources, err := s.store.ListResourceSources(ctx)
	if err != nil {
		return store.ResourceList{}, err
	}
	online := map[string]bool{}
	for index, source := range sources {
		if s.Online != nil && source.Kind == "device" {
			sources[index].Online = s.Online(source.ID)
		}
		if sources[index].DetectorErrors == nil {
			sources[index].DetectorErrors = []store.ResourceDetectorError{}
		}
		online[source.ID] = sources[index].Online
	}
	for index, instance := range instances {
		if !online[instance.Source.ID] {
			instances[index] = offline(instance)
		}
	}
	if instances == nil {
		instances = []store.ResourceInstance{}
	}
	return store.ResourceList{Instances: instances, Sources: sources}, nil
}

// Settings reads what a source's owner allows.
func (s *Service) Settings(ctx context.Context, sourceID string) (store.ResourceSourceSettings, error) {
	return s.store.ResourceSourceSettings(ctx, sourceID)
}

// SetSettings keeps what a source's owner (byUserID) allows, and applies
// it to the leases on its instances.
func (s *Service) SetSettings(ctx context.Context, sourceID string, settings store.ResourceSourceSettings, byUserID string) error {
	if strings.TrimSpace(sourceID) == "" {
		return ErrNoSource
	}
	s.mu.Lock()
	err := s.store.SetResourceSourceSettings(ctx, sourceID, settings, byUserID)
	s.mu.Unlock()
	if err != nil {
		return err
	}
	if s.leases != nil {
		if err := s.leases.SettingsChanged(ctx, sourceID, settings, byUserID); err != nil {
			return err
		}
	}
	if s.Changed != nil {
		s.Changed(sourceID)
	}
	return nil
}

func (s *Service) sourceStatus(ctx context.Context, sourceID string) (*store.ResourceSourceStatus, error) {
	sources, err := s.store.ListResourceSources(ctx)
	if err != nil {
		return nil, err
	}
	for _, source := range sources {
		if source.ID == sourceID {
			return &source, nil
		}
	}
	return nil, nil
}

// Reconcile is the source's whole set of instances after report, given
// what it had (existing, gone ones included):
//   - each reported instance is current (available or unready by its
//     readiness), keeping when it was first discovered;
//   - one not reported whose detector failed in this report keeps its last
//     known values, marked stale;
//   - any other one not reported is gone (once; it keeps when it went).
func Reconcile(existing []store.ResourceInstance, source store.ResourceSource, report store.ResourcesReport, now time.Time) []store.ResourceInstance {
	at := formatTime(now)
	failed := map[string]bool{}
	for _, failure := range report.DetectorErrors {
		failed[detectorName(failure.Detector)] = true
	}
	before := map[string]store.ResourceInstance{}
	for _, instance := range existing {
		before[instance.Key] = instance
	}
	result := make([]store.ResourceInstance, 0, len(report.Instances)+len(existing))
	reported := map[string]bool{}
	for _, detected := range report.Instances {
		if reported[detected.Key] {
			continue
		}
		reported[detected.Key] = true
		instance := store.ResourceInstance{
			ID: InstanceID(source.ID, detected.Key), Key: detected.Key, Type: detected.Type,
			Platform: detected.Platform, Name: detected.Name, Source: source,
			Readiness: detected.Readiness, Backends: detected.Backends, Details: detected.Details,
			Detector: detected.Detector, DiscoveredAt: at, LastSeenAt: at,
		}
		if previous, ok := before[detected.Key]; ok && previous.DiscoveredAt != "" {
			instance.DiscoveredAt = previous.DiscoveredAt
		}
		instance.State, instance.StateReason = readinessState(detected.Readiness)
		result = append(result, instance)
	}
	for _, previous := range existing {
		if reported[previous.Key] {
			continue
		}
		previous.Source = source
		switch {
		case previous.State == store.ResourceGone:
		case failed[detectorName(previous.Detector)]:
			previous.Stale = true
			previous.State, previous.StateReason = readinessState(previous.Readiness)
		default:
			previous.State, previous.StateReason = store.ResourceGone, reasonGone
			previous.Stale = false
			previous.GoneAt = at
		}
		result = append(result, previous)
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].Key < result[j].Key })
	return result
}

// Sanitize bounds a report and fills what it left out: at most
// MaxInstancesPerReport instances with a key and a type, bounded text, no
// nil lists.
func Sanitize(report store.ResourcesReport) store.ResourcesReport {
	instances := make([]store.DetectedResource, 0, min(len(report.Instances), MaxInstancesPerReport))
	for _, detected := range report.Instances {
		if len(instances) == MaxInstancesPerReport {
			break
		}
		detected.Key = clip(strings.TrimSpace(detected.Key))
		detected.Type = clip(strings.TrimSpace(detected.Type))
		if detected.Key == "" || detected.Type == "" {
			continue
		}
		detected.Name = clip(detected.Name)
		if detected.Name == "" {
			detected.Name = detected.Key
		}
		if detected.Platform == "" {
			detected.Platform = "any"
		}
		detected.Detector = clip(detected.Detector)
		detected.Readiness = sanitizeReadiness(detected.Readiness)
		if len(detected.Backends) > maxBackends {
			detected.Backends = detected.Backends[:maxBackends]
		}
		backends := make([]store.ResourceBackend, 0, len(detected.Backends))
		for _, backend := range detected.Backends {
			backend.ID = clip(backend.ID)
			backend.Version = clip(backend.Version)
			if backend.Mode == "" {
				backend.Mode = "listed"
			}
			backend.Readiness = sanitizeReadiness(backend.Readiness)
			backends = append(backends, backend)
		}
		detected.Backends = backends
		detected.Details = sanitizeDetails(detected.Details)
		instances = append(instances, detected)
	}
	report.Instances = instances
	if len(report.DetectorErrors) > maxDetectorErrors {
		report.DetectorErrors = report.DetectorErrors[:maxDetectorErrors]
	}
	errorsOut := make([]store.ResourceDetectorError, 0, len(report.DetectorErrors))
	for _, failure := range report.DetectorErrors {
		failure.Detector, failure.Type, failure.Error = clip(failure.Detector), clip(failure.Type), clip(failure.Error)
		errorsOut = append(errorsOut, failure)
	}
	report.DetectorErrors = errorsOut
	return report
}

// LegacyReport converts a registration's device.resources: a browser
// "browser:<family>" becomes key "browser/<family>", macOS screen control
// "computer_use:macos" key "computer_use/macos", each listed only.
func LegacyReport(resources []store.DeviceResource, now time.Time) store.ResourcesReport {
	report := store.ResourcesReport{ScannedAt: formatTime(now), Instances: []store.DetectedResource{}, DetectorErrors: []store.ResourceDetectorError{}}
	for _, resource := range resources {
		platform := "any"
		if resource.Kind == "computer_use" {
			platform = "macos"
		}
		readiness := store.ResourceReadiness{Ready: resource.Available, Level: "installed"}
		if !resource.Available {
			readiness.Reason = resource.Detail
		} else if resource.Kind == "computer_use" {
			readiness.Level = "permitted"
		}
		report.Instances = append(report.Instances, store.DetectedResource{
			Key: strings.Replace(resource.ID, ":", "/", 1), Type: resource.Kind, Platform: platform,
			Name: resource.Name, Detector: legacyDetector, Readiness: readiness, Details: resource.Attributes,
		})
	}
	return report
}

func sanitizeReadiness(readiness store.ResourceReadiness) store.ResourceReadiness {
	switch readiness.Level {
	case "installed", "configured", "permitted":
	case "verified":
		// Only a real use verifies; detection never does.
		readiness.Level = "permitted"
	default:
		readiness.Level = "installed"
	}
	readiness.Reason = clip(readiness.Reason)
	if len(readiness.Missing) > maxDetails {
		readiness.Missing = readiness.Missing[:maxDetails]
	}
	for index, code := range readiness.Missing {
		readiness.Missing[index] = clip(code)
	}
	return readiness
}

func sanitizeDetails(details map[string]string) map[string]string {
	if len(details) == 0 {
		return nil
	}
	names := make([]string, 0, len(details))
	for name := range details {
		names = append(names, name)
	}
	sort.Strings(names)
	result := map[string]string{}
	for _, name := range names {
		if len(result) == maxDetails {
			break
		}
		result[clip(name)] = clip(details[name])
	}
	return result
}

// readinessState is the state a current instance with readiness has.
func readinessState(readiness store.ResourceReadiness) (string, string) {
	if readiness.Ready {
		return store.ResourceAvailable, ""
	}
	return store.ResourceUnready, readiness.Reason
}

func offline(instance store.ResourceInstance) store.ResourceInstance {
	if instance.State != store.ResourceGone {
		instance.State, instance.StateReason = store.ResourceOffline, reasonOffline
	}
	return instance
}

// detectorName is a detector without its version: a new version of the
// same detector still accounts for what an older one found.
func detectorName(detector string) string {
	name, _, _ := strings.Cut(detector, "@")
	return name
}

// sameListing reports whether two sets of instances read the same, apart
// from when they were last seen.
func sameListing(left, right []store.ResourceInstance) bool {
	if len(left) != len(right) {
		return false
	}
	byKey := map[string]store.ResourceInstance{}
	for _, instance := range left {
		instance.LastSeenAt = ""
		byKey[instance.Key] = instance
	}
	for _, instance := range right {
		instance.LastSeenAt = ""
		previous, ok := byKey[instance.Key]
		if !ok || !reflect.DeepEqual(normalized(previous), normalized(instance)) {
			return false
		}
	}
	return true
}

// normalized treats empty and nil lists and maps alike.
func normalized(instance store.ResourceInstance) store.ResourceInstance {
	if len(instance.Backends) == 0 {
		instance.Backends = nil
	}
	if len(instance.Details) == 0 {
		instance.Details = nil
	}
	if len(instance.Readiness.Missing) == 0 {
		instance.Readiness.Missing = nil
	}
	return instance
}

func sameSource(left, right store.ResourceSourceStatus) bool {
	left.LastReportAt, right.LastReportAt = "", ""
	// Settings are the owner's, never a report's.
	left.AllowRemoteCommands, right.AllowRemoteCommands = false, false
	if len(left.DetectorErrors) == 0 {
		left.DetectorErrors = nil
	}
	if len(right.DetectorErrors) == 0 {
		right.DetectorErrors = nil
	}
	return reflect.DeepEqual(left, right)
}
