package store

import "context"

// SessionToolFrame is a screenshot a tool call produced, which the worker
// keeps as a session file under the workspace's .foundry/attachments/frames
// (DEV-075). Events carry only this reference; the image is read on demand
// through the session, by those who may read the session.
type SessionToolFrame struct {
	ID         string `json:"id"`
	CallID     string `json:"callId"`
	Tool       string `json:"tool"`
	Source     string `json:"source"`
	Path       string `json:"path"`
	MIMEType   string `json:"mimeType"`
	Bytes      int64  `json:"bytes"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	CapturedAt string `json:"capturedAt"`
	InputID    string `json:"inputId,omitempty"`
}

// Session frame limits: a session keeps its newest frames within both.
const (
	SessionToolFrameLimitCount = 200
	SessionToolFrameLimitBytes = 50 * 1024 * 1024
)

// SessionToolFrameList is a session's kept frames, oldest first, and how
// many older ones the limits dropped.
type SessionToolFrameList struct {
	Frames  []SessionToolFrame        `json:"frames"`
	Dropped int                       `json:"dropped"`
	Limits  SessionToolFrameListLimit `json:"limits"`
}

// SessionToolFrameListLimit names the limits a frame list was cut to.
type SessionToolFrameListLimit struct {
	Count int   `json:"count"`
	Bytes int64 `json:"bytes"`
}

// SessionFrameStore lists the frames a session's tools produced.
type SessionFrameStore interface {
	// AgentSessionFrames returns the session's frames, oldest first.
	AgentSessionFrames(ctx context.Context, sessionID string) ([]SessionToolFrame, error)
}

// RetainSessionFrames splits a session's frames (oldest first) into the
// newest that fit both limits together and the older ones dropped: once a
// frame does not fit, it and every older one are dropped. The worker
// applies the same rule to the files on the device.
func RetainSessionFrames(frames []SessionToolFrame, count int, bytes int64) (kept, dropped []SessionToolFrame) {
	cut := len(frames)
	var total int64
	for index := len(frames) - 1; index >= 0; index-- {
		size := max(frames[index].Bytes, 0)
		if len(frames)-index > count || total+size > bytes {
			break
		}
		total += size
		cut = index
	}
	return frames[cut:], frames[:cut]
}
