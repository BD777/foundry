package personalagent

import (
	_ "embed"
	"strings"
)

//go:embed agents.md
var agentsFile string

// AgentsFile is the AGENTS.md Foundry writes into the assistant's folder
// (§2): what the folder is and what each part holds, at most
// AgentsFileMaxLines lines.
func AgentsFile() string { return agentsFile }

// HomeFolderName is the name of the assistant's folder under a device's
// first managed root.
var HomeFolderName = strings.TrimPrefix(HomeFolder, DefaultManagedRoot+"/")

// HomeFolders are what moving the assistant to another computer copies from
// its folder: its routing notes, its own notes and its log (§2).
var HomeFolders = []string{"cards", "notes", "log"}
