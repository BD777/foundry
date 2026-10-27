package httpapi

import "testing"

func TestDaemonTrafficCountsOnlySizesAndBoundedMinutes(t *testing.T) {
	var traffic daemonTraffic
	traffic.add("wire", "reply_chunk", 4200)
	traffic.add("logical", "session_event", 4000)
	stats := traffic.snapshot().(map[string]any)
	if stats["wire"].(map[string]daemonTrafficCount)["reply_chunk"].Bytes != 4200 || stats["logical"].(map[string]daemonTrafficCount)["session_event"].Count != 1 {
		t.Fatal(stats)
	}
	traffic.mu.Lock()
	for i := range traffic.buckets {
		traffic.buckets[i].at -= 7
	}
	traffic.mu.Unlock()
	if len(traffic.snapshot().(map[string]any)["wire"].(map[string]daemonTrafficCount)) != 0 {
		t.Fatal("old traffic retained")
	}
}
