package httpapi

import "testing"

// A loopback upstream is reachable only from the device that validated it.
func TestExtensionNetworkLoopbackTargetsStayOnTheProbeDevice(t *testing.T) {
	for target, want := range map[string]bool{
		"127.0.0.1:8081":         true,
		"[::1]:8081":             true,
		"localhost:8081":         true,
		"openlark.localhost:443": true,
		"10.37.93.185:443":       false,
		"192.168.1.166:5055":     false,
		"openlark.example:443":   false,
	} {
		if got := extensionNetworkLoopback(target); got != want {
			t.Errorf("extensionNetworkLoopback(%q) = %v, want %v", target, got, want)
		}
	}
}
