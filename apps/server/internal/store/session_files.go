package store

// SessionFileRecord is a file a session's own write tools changed, or its
// answer named, recorded once per turn by the worker.
type SessionFileRecord struct {
	Path          string `json:"path"`
	WorkspacePath string `json:"workspacePath,omitempty"`
	Origin        string `json:"origin"`
	Op            string `json:"op"`
	InGitRepo     bool   `json:"inGitRepo"`
	InputID       string `json:"inputId,omitempty"`
	Agent         string `json:"agent,omitempty"`
	Bytes         *int64 `json:"bytes,omitempty"`
	Added         *int   `json:"added,omitempty"`
	Removed       *int   `json:"removed,omitempty"`
	TotalAdded    *int   `json:"totalAdded,omitempty"`
	TotalRemoved  *int   `json:"totalRemoved,omitempty"`
}

// SessionFileReference is a path an answer names that its device verified.
type SessionFileReference struct {
	Text string `json:"text"`
	Path string `json:"path"`
	Kind string `json:"kind"`
	// Pending: no file was there when the answer ended; it links once one is.
	Pending bool `json:"pending,omitempty"`
}

// SessionFileRead is one of a session's recorded files, read from its device.
type SessionFileRead struct {
	SessionID            string `json:"sessionId"`
	Path                 string `json:"path"`
	WorkspacePath        string `json:"workspacePath,omitempty"`
	Origin               string `json:"origin"`
	InsideWorkspace      bool   `json:"insideWorkspace"`
	Kind                 string `json:"kind"`
	Content              string `json:"content,omitempty"`
	DataBase64           string `json:"dataBase64,omitempty"`
	MIMEType             string `json:"mimeType,omitempty"`
	Truncated            bool   `json:"truncated"`
	Bytes                *int64 `json:"bytes,omitempty"`
	Mtime                string `json:"mtime,omitempty"`
	ChangedSinceRecorded bool   `json:"changedSinceRecorded"`
}

// SessionFileDiff is what a session's own writes changed in one of its
// recorded files, read from its device: one turn's or the whole session's.
type SessionFileDiff struct {
	SessionID            string  `json:"sessionId"`
	Path                 string  `json:"path"`
	WorkspacePath        string  `json:"workspacePath,omitempty"`
	Origin               string  `json:"origin"`
	InsideWorkspace      bool    `json:"insideWorkspace"`
	InputID              string  `json:"inputId,omitempty"`
	Source               string  `json:"source"`
	Before               *string `json:"before,omitempty"`
	After                *string `json:"after,omitempty"`
	BeforeLabel          string  `json:"beforeLabel"`
	AfterLabel           string  `json:"afterLabel"`
	MayIncludeOtherEdits bool    `json:"mayIncludeOtherEdits"`
	ChangedSince         bool    `json:"changedSince"`
	Truncated            bool    `json:"truncated"`
	Binary               bool    `json:"binary"`
	TooLarge             bool    `json:"tooLarge"`
	Unavailable          string  `json:"unavailable,omitempty"`
	Added                *int    `json:"added,omitempty"`
	Removed              *int    `json:"removed,omitempty"`
}
