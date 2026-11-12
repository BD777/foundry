package externalaccounts

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func extensionDeviceFixture(t *testing.T, baseURL string, reach map[string]error) (*Service, store.ConnectorDescriptor, map[string]string, map[string]string, *[]string) {
	t.Helper()
	service := NewService(nil, nil, NewRegistry())
	var mu sync.Mutex
	via := []string{}
	service.ExtensionDeviceRequest = func(_ context.Context, deviceID string, request ExtensionDeviceHTTPRequest) (ExtensionDeviceHTTPResponse, error) {
		mu.Lock()
		via = append(via, deviceID)
		mu.Unlock()
		if err := reach[deviceID]; err != nil {
			return ExtensionDeviceHTTPResponse{}, err
		}
		if request.Headers["Authorization"] != "Bearer fixture-secret" {
			return ExtensionDeviceHTTPResponse{Status: http.StatusUnauthorized}, nil
		}
		return ExtensionDeviceHTTPResponse{Status: http.StatusOK, Headers: http.Header{}, Body: []byte(`{}`)}, nil
	}
	service.ExtensionDevices = func(context.Context, string, string) ([]ExtensionDeviceCandidate, error) {
		return []ExtensionDeviceCandidate{
			{ID: "dev_probe", Name: "byte-dev", Online: true, Installed: true},
			{ID: "dev_mac", Name: "alice-mac", Online: true, Installed: true},
			{ID: "dev_nas", Name: "alice-nas", Online: true, Installed: true},
			{ID: "dev_off", Name: "alice-offline", Online: false, Installed: true},
			{ID: "dev_bare", Name: "alice-bare", Online: true, Installed: false},
		}, nil
	}
	return service, extensionTestDescriptor(baseURL), map[string]string{"baseUrl": baseURL}, map[string]string{"token": "fixture-secret"}, &via
}

func checkByDevice(checks []store.ConnectorServerHeldDeviceCheck) map[string]store.ConnectorServerHeldDeviceCheck {
	byID := map[string]store.ConnectorServerHeldDeviceCheck{}
	for _, check := range checks {
		byID[check.DeviceID] = check
	}
	return byID
}

func TestExtensionLoopbackAddressIsOnlyUsableOnTheProbeDevice(t *testing.T) {
	for address, want := range map[string]bool{
		"http://127.0.0.1:8081":      true,
		"http://[::1]:8081/openlark": true,
		"http://localhost:8081":      true,
		"https://openlark.localhost": true,
		"http://10.37.93.185:443":    false,
		"http://192.168.1.166:5055":  false,
		"https://openlark.example":   false,
	} {
		if got := ExtensionAddressLoopback(address); got != want {
			t.Errorf("ExtensionAddressLoopback(%q) = %v, want %v", address, got, want)
		}
	}
	service, descriptor, values, secrets, via := extensionDeviceFixture(t, "http://127.0.0.1:8081", nil)
	checks, err := service.checkExtensionDevices(context.Background(), "owner_1", descriptor, values, secrets, "dev_probe", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	byID := checkByDevice(checks)
	if byID["dev_probe"].Status != ExtensionDeviceOK {
		t.Fatalf("probe device = %+v", byID["dev_probe"])
	}
	for _, id := range []string{"dev_mac", "dev_nas", "dev_off", "dev_bare"} {
		check := byID[id]
		if check.Status != ExtensionDeviceNotApplicable || !strings.Contains(check.Detail, "only works on byte-dev") {
			t.Errorf("%s = %+v", id, check)
		}
	}
	if len(*via) != 0 {
		t.Fatalf("a loopback address was probed through devices %v", *via)
	}
}

func TestExtensionLANAddressIsProbedFromEveryOnlineDevice(t *testing.T) {
	service, descriptor, values, secrets, via := extensionDeviceFixture(t, "http://10.37.93.185:8081/openlark", map[string]error{
		"dev_nas": &ExtensionProbeError{Class: "unreachable", Message: "dial tcp 10.37.93.185:8081: i/o timeout"},
	})
	checks, err := service.checkExtensionDevices(context.Background(), "owner_1", descriptor, values, secrets, "dev_probe", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	byID := checkByDevice(checks)
	if byID["dev_probe"].Status != ExtensionDeviceOK || byID["dev_mac"].Status != ExtensionDeviceOK {
		t.Fatalf("reachable devices = %+v", checks)
	}
	if nas := byID["dev_nas"]; nas.Status != ExtensionDeviceUnreachable || !strings.Contains(nas.Detail, "i/o timeout") {
		t.Fatalf("nas = %+v", nas)
	}
	if _, probed := byID["dev_off"]; probed {
		t.Fatalf("an offline device was recorded: %+v", byID["dev_off"])
	}
	if _, probed := byID["dev_bare"]; probed {
		t.Fatalf("a device without the extension was recorded: %+v", byID["dev_bare"])
	}
	if len(*via) != 2 || strings.Contains(strings.Join(*via, ","), "dev_probe") {
		t.Fatalf("probes went through %v, want the other online devices only", *via)
	}

	service, descriptor, values, secrets, _ = extensionDeviceFixture(t, "http://10.37.93.185:8081/openlark", map[string]error{"dev_mac": errors.New("device daemon refused")})
	next, err := service.checkExtensionDevices(context.Background(), "owner_1", descriptor, values, secrets, "dev_probe", checks, true)
	if err != nil {
		t.Fatal(err)
	}
	if got := checkByDevice(next); got["dev_mac"].Status != ExtensionDeviceOK || got["dev_nas"].Status != ExtensionDeviceUnreachable {
		t.Fatalf("an unchecked-only pass changed recorded devices: %+v", next)
	}
	service.ExtensionDevices = func(context.Context, string, string) ([]ExtensionDeviceCandidate, error) {
		return []ExtensionDeviceCandidate{{ID: "dev_probe", Name: "byte-dev", Online: true, Installed: true}, {ID: "dev_new", Name: "alice-new", Online: true, Installed: true}}, nil
	}
	service.ExtensionDeviceRequest = func(context.Context, string, ExtensionDeviceHTTPRequest) (ExtensionDeviceHTTPResponse, error) {
		return ExtensionDeviceHTTPResponse{Status: http.StatusForbidden}, nil
	}
	next, err = service.checkExtensionDevices(context.Background(), "owner_1", descriptor, values, secrets, "dev_probe", checks, true)
	if err != nil {
		t.Fatal(err)
	}
	got := checkByDevice(next)
	if got["dev_new"].Status != ExtensionDeviceError || got["dev_mac"].Status != ExtensionDeviceOK || len(next) != 4 {
		t.Fatalf("a device seen for the first time = %+v", next)
	}
}
