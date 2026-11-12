package externalaccounts

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	// Statuses recorded in ConnectorServerHeldDeviceCheck.Status.
	ExtensionDeviceOK            = "ok"
	ExtensionDeviceUnreachable   = "unreachable"
	ExtensionDeviceError         = "error"
	ExtensionDeviceNotApplicable = "not_applicable"

	extensionDeviceProbeTimeout     = 10 * time.Second
	extensionDeviceProbeConcurrency = 4
)

// ExtensionDeviceCandidate is one of the owner's devices a device-network
// instance may run on. Online and Installed say whether a probe can run there
// now and whether its sessions could use the connector extension.
type ExtensionDeviceCandidate struct {
	ID        string
	Name      string
	Online    bool
	Installed bool
}

// ExtensionAddressLoopback reports a server URL that names each machine's own
// loopback, so only the machine that validated it reaches the upstream.
func ExtensionAddressLoopback(baseURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// checkExtensionDevices probes the instance's upstream from each of the
// owner's candidate devices and returns the merged record. Devices that cannot
// be probed now (offline, extension not installed) keep their previous entry.
// With onlyUnchecked, devices that already have an entry are left alone.
func (s *Service) checkExtensionDevices(ctx context.Context, ownerUserID string, descriptor store.ConnectorDescriptor, values, secrets map[string]string, probeDeviceID string, previous []store.ConnectorServerHeldDeviceCheck, onlyUnchecked bool) ([]store.ConnectorServerHeldDeviceCheck, error) {
	if s.ExtensionDevices == nil {
		return nil, errors.New("this server cannot check extension devices")
	}
	serverHeld := descriptor.ServerHeld
	baseURL := extensionBaseURL(serverHeld, values[serverHeld.Upstream.BaseField])
	candidates, err := s.ExtensionDevices(ctx, ownerUserID, descriptor.Kind)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	entries := map[string]store.ConnectorServerHeldDeviceCheck{}
	for _, check := range previous {
		entries[check.DeviceID] = check
	}
	names := map[string]string{}
	for _, candidate := range candidates {
		names[candidate.ID] = candidate.Name
	}
	nameOf := func(deviceID string) string {
		if names[deviceID] != "" {
			return names[deviceID]
		}
		return deviceID
	}
	if probeDeviceID != "" && !(onlyUnchecked && hasDeviceCheck(entries, probeDeviceID)) {
		// The full probe that just ran on this device proved the upstream works.
		entries[probeDeviceID] = store.ConnectorServerHeldDeviceCheck{
			DeviceID: probeDeviceID, Name: nameOf(probeDeviceID), Status: ExtensionDeviceOK, CheckedAt: now,
		}
	}
	loopback := ExtensionAddressLoopback(baseURL)
	var queued []ExtensionDeviceCandidate
	for _, candidate := range candidates {
		if candidate.ID == probeDeviceID || (onlyUnchecked && hasDeviceCheck(entries, candidate.ID)) {
			continue
		}
		if loopback {
			entries[candidate.ID] = store.ConnectorServerHeldDeviceCheck{
				DeviceID: candidate.ID, Name: candidate.Name, Status: ExtensionDeviceNotApplicable, CheckedAt: now,
				Detail: fmt.Sprintf("This address only works on %s.", nameOf(probeDeviceID)),
			}
			continue
		}
		if candidate.Online && candidate.Installed {
			queued = append(queued, candidate)
		}
	}
	var (
		mu    sync.Mutex
		waits sync.WaitGroup
		slots = make(chan struct{}, extensionDeviceProbeConcurrency)
	)
	for _, candidate := range queued {
		waits.Add(1)
		slots <- struct{}{}
		go func(candidate ExtensionDeviceCandidate) {
			defer waits.Done()
			defer func() { <-slots }()
			status, detail := s.probeExtensionOnDevice(ctx, ownerUserID, descriptor, baseURL, values, secrets, candidate.ID)
			mu.Lock()
			entries[candidate.ID] = store.ConnectorServerHeldDeviceCheck{
				DeviceID: candidate.ID, Name: candidate.Name, Status: status, CheckedAt: time.Now().UTC().Format(time.RFC3339), Detail: detail,
			}
			mu.Unlock()
		}(candidate)
	}
	waits.Wait()
	result := make([]store.ConnectorServerHeldDeviceCheck, 0, len(entries))
	seen := map[string]bool{}
	for _, candidate := range candidates {
		if check, ok := entries[candidate.ID]; ok {
			result = append(result, check)
			seen[candidate.ID] = true
		}
	}
	for _, check := range previous {
		if !seen[check.DeviceID] {
			result = append(result, entries[check.DeviceID])
			seen[check.DeviceID] = true
		}
	}
	if probeDeviceID != "" && !seen[probeDeviceID] {
		result = append(result, entries[probeDeviceID])
	}
	return result, nil
}

func hasDeviceCheck(entries map[string]store.ConnectorServerHeldDeviceCheck, deviceID string) bool {
	_, ok := entries[deviceID]
	return ok
}

// probeExtensionOnDevice sends the extension's first required probe request
// through the device. Secrets only live in this request's memory.
func (s *Service) probeExtensionOnDevice(ctx context.Context, ownerUserID string, descriptor store.ConnectorDescriptor, baseURL string, values, secrets map[string]string, deviceID string) (string, string) {
	serverHeld := descriptor.ServerHeld
	probe := serverHeld.Probe
	if len(probe) == 0 {
		return ExtensionDeviceError, "the connector declares no probe request"
	}
	request := probe[0]
	for _, candidate := range probe {
		if !candidate.Optional {
			request = candidate
			break
		}
	}
	endpoint, err := s.extensionClient().endpointForNetwork(ctx, baseURL, ExtensionNetworkDevice, deviceID)
	if err != nil {
		return ExtensionDeviceError, deviceProbeDetail(err)
	}
	probeCtx, cancel := context.WithTimeout(ctx, extensionDeviceProbeTimeout)
	defer cancel()
	_, _, err = s.extensionJSON(probeCtx, ownerUserID, nil, endpoint, request.Method, request.Path, serverHeld.Upstream.Headers, values, secrets, extensionProbeLimit)
	if err == nil {
		return ExtensionDeviceOK, ""
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(probeCtx.Err(), context.DeadlineExceeded) {
		return ExtensionDeviceUnreachable, "no answer within 10 seconds"
	}
	var probeErr *ExtensionProbeError
	if errors.As(err, &probeErr) {
		switch probeErr.Class {
		case "unreachable", "timeout", "tls_error", "redirect_refused", "unavailable":
			return ExtensionDeviceUnreachable, deviceProbeDetail(err)
		}
	}
	return ExtensionDeviceError, deviceProbeDetail(err)
}

// ProbeExtensionOnNewDevice records a probe for every device-network instance
// of the device's owner that has no entry for the device yet. It is called when
// a device comes online.
func (s *Service) ProbeExtensionOnNewDevice(ctx context.Context, ownerUserID, deviceID string) error {
	st, err := s.extensionStore()
	if err != nil {
		return err
	}
	apps, err := s.store.ListExternalProviderApps(ctx, ownerUserID)
	if err != nil {
		return err
	}
	var failures []error
	for _, app := range apps {
		if app.OwnerUserID != ownerUserID || app.CreatedVia != "extension" {
			continue
		}
		data, err := decodeExtensionData(app)
		if err != nil || data.Network != ExtensionNetworkDevice || data.Descriptor.ServerHeld == nil || data.ProbeDeviceID == "" {
			continue
		}
		if hasDeviceCheck(deviceChecksByID(data.AvailableDevices), deviceID) {
			continue
		}
		account, err := s.extensionAccount(ctx, ownerUserID, app.Provider, app.ID)
		if err != nil || (account.Status != store.ExternalAccountReady && account.Status != store.ExternalAccountExpiring) {
			continue
		}
		secrets, err := s.loadExtensionSecrets(ctx, app.ID)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		devices, err := s.checkExtensionDevices(ctx, ownerUserID, data.Descriptor, data.Values, secrets, data.ProbeDeviceID, data.AvailableDevices, true)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		data.AvailableDevices = devices
		raw, err := encodeExtensionData(data)
		if err == nil {
			_, err = st.SaveExternalProviderAppExtensionData(ctx, app.ID, raw)
		}
		if err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func deviceChecksByID(checks []store.ConnectorServerHeldDeviceCheck) map[string]store.ConnectorServerHeldDeviceCheck {
	byID := map[string]store.ConnectorServerHeldDeviceCheck{}
	for _, check := range checks {
		byID[check.DeviceID] = check
	}
	return byID
}

// deviceProbeDetail is the device's own failure text; the status already
// carries the failure class.
func deviceProbeDetail(err error) string {
	var probeErr *ExtensionProbeError
	if errors.As(err, &probeErr) && probeErr.Message != "" {
		return probeErr.Message
	}
	return err.Error()
}
