package store

import (
	"strings"
	"testing"
)

func TestNormalizeSessionInputAnnotationsDropsUnusableAndCaps(t *testing.T) {
	long := strings.Repeat("字", maxSessionInputAnnotationText+5)
	input := []SessionInputAnnotation{
		{ID: " ", SelectedText: "no id"},
		{ID: "empty", SelectedText: "   "},
		{ID: "a", SelectedText: " kept ", Comment: long, SourceEventID: "evt_1", TurnNumber: 3},
		{ID: "a", SelectedText: "duplicate id"},
	}
	for index := 0; index < maxSessionInputAnnotations+5; index++ {
		input = append(input, SessionInputAnnotation{ID: "x" + string(rune('A'+index)), SelectedText: "s", SourceEventID: "evt_2"})
	}

	got := NormalizeSessionInputAnnotations(input)
	if len(got) != maxSessionInputAnnotations {
		t.Fatalf("len = %d, want %d", len(got), maxSessionInputAnnotations)
	}
	first := got[0]
	if first.ID != "a" || first.SelectedText != "kept" || first.SourceEventID != "evt_1" || first.TurnNumber != 3 {
		t.Fatalf("first = %+v", first)
	}
	if n := len([]rune(first.Comment)); n != maxSessionInputAnnotationText {
		t.Fatalf("comment runes = %d, want %d", n, maxSessionInputAnnotationText)
	}
	offsets := NormalizeSessionInputAnnotations([]SessionInputAnnotation{
		{ID: "ok", SelectedText: "s", StartOffset: int64Ptr(4), EndOffset: int64Ptr(9)},
		{ID: "negative", SelectedText: "s", StartOffset: int64Ptr(-1), EndOffset: int64Ptr(9)},
		{ID: "inverted", SelectedText: "s", StartOffset: int64Ptr(9), EndOffset: int64Ptr(4)},
		{ID: "half", SelectedText: "s", StartOffset: int64Ptr(4)},
	})
	if len(offsets) != 4 || *offsets[0].StartOffset != 4 || *offsets[0].EndOffset != 9 {
		t.Fatalf("valid offsets not kept: %+v", offsets)
	}
	for _, annotation := range offsets[1:] {
		if annotation.StartOffset != nil || annotation.EndOffset != nil {
			t.Fatalf("%s kept an unusable range: %+v", annotation.ID, annotation)
		}
	}
	if NormalizeSessionInputAnnotations([]SessionInputAnnotation{{ID: "", SelectedText: "x"}}) != nil {
		t.Fatal("all-invalid annotations should normalize to nil")
	}
}

func TestSessionInputEventsCarryAnnotationsOnTheUserMessage(t *testing.T) {
	annotations := []SessionInputAnnotation{{ID: "ann_1", SelectedText: "passage", Comment: "why", SourceEventID: "evt_answer", TurnNumber: 2, MessageAt: "2026-11-17T01:00:00Z"}}
	input := SessionInput{ID: "in_1", Prompt: "typed text", Annotations: annotations}

	events := SessionInputEvents("sess_1", input)
	message := events[len(events)-1].Message
	if message == nil || message.Text != "typed text" {
		t.Fatalf("user message = %+v; the transcript text must stay the prompt the person sent", message)
	}
	if len(message.Annotations) != 1 || message.Annotations[0] != annotations[0] {
		t.Fatalf("annotations = %+v", message.Annotations)
	}
}

func int64Ptr(value int64) *int64 { return &value }
