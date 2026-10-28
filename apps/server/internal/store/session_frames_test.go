package store

import "testing"

func TestRetainSessionFramesKeepsTheNewestWithinBothLimits(t *testing.T) {
	frames := func(sizes ...int64) []SessionToolFrame {
		out := make([]SessionToolFrame, len(sizes))
		for index, size := range sizes {
			out[index] = SessionToolFrame{ID: string(rune('a' + index)), Bytes: size}
		}
		return out
	}
	ids := func(list []SessionToolFrame) string {
		out := ""
		for _, frame := range list {
			out += frame.ID
		}
		return out
	}
	kept, dropped := RetainSessionFrames(frames(1, 1, 1, 1, 1), 3, 100)
	if ids(kept) != "cde" || ids(dropped) != "ab" {
		t.Fatalf("by count: kept %s dropped %s", ids(kept), ids(dropped))
	}
	kept, dropped = RetainSessionFrames(frames(10, 10, 10, 10), 100, 25)
	if ids(kept) != "cd" || ids(dropped) != "ab" {
		t.Fatalf("by bytes: kept %s dropped %s", ids(kept), ids(dropped))
	}
	// A frame that does not fit drops every older one, even small ones.
	kept, dropped = RetainSessionFrames(frames(1, 40, 1), 100, 30)
	if ids(kept) != "c" || ids(dropped) != "ab" {
		t.Fatalf("cut: kept %s dropped %s", ids(kept), ids(dropped))
	}
	kept, dropped = RetainSessionFrames(nil, SessionToolFrameLimitCount, SessionToolFrameLimitBytes)
	if len(kept) != 0 || len(dropped) != 0 {
		t.Fatal("empty")
	}
	many := make([]SessionToolFrame, 0, 260)
	for index := 0; index < 260; index++ {
		many = append(many, SessionToolFrame{Bytes: 300 * 1024})
	}
	kept, dropped = RetainSessionFrames(many, SessionToolFrameLimitCount, SessionToolFrameLimitBytes)
	// 50 MiB / 300 KiB = 170 frames fit before the count limit.
	if len(kept) != 170 || len(dropped) != 90 {
		t.Fatalf("production limits: kept %d dropped %d", len(kept), len(dropped))
	}
}
