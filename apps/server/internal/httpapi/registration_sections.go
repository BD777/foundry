package httpapi

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A worker registers every workspace it serves again on each connection, and
// all of them again when its agents' health changes: on a slow uplink the
// same tens of kilobytes per workspace went out after every reconnect. The
// server keeps the sections of the registrations a device sent, by the
// digest the device gave each, for as long as it runs; a registration may
// then leave out a section the server has (omittedSections) and the server
// takes it from what it kept. One it does not have (it restarted, or never
// got it) is answered with registration_needed, and the device sends that
// registration again in full. What is filled in is exactly what the device
// sent under that digest, so the registration is handled as if it had come
// whole.
//
// The upgrade's response header tells the worker the server takes this
// before it sends its hello; an older server sends no header, and an older
// worker never leaves anything out.

// daemonFeaturesHeader names what the server takes, in the response to the
// daemon socket's upgrade.
const daemonFeaturesHeader = "Foundry-Daemon-Features"

// registrationSectionsFeature: registrations may leave out sections the
// server keeps.
const registrationSectionsFeature = "registration_sections"

// wsRegistrationNeededPayload answers a registration that left out sections
// the server does not have.
type wsRegistrationNeededPayload struct {
	Sections []string `json:"sections"`
}

// Each section is the registration fields it stands for, with the same JSON
// names: decoded into a registration, a kept section sets those fields only.
type deviceSection struct {
	AgentProfiles  []store.AgentProfileProjection `json:"agentProfiles"`
	ProviderHealth []store.ProviderHealth         `json:"providerHealth"`
}

type workspaceSection struct {
	Assets         []store.AssetProjection    `json:"assets"`
	Agents         []store.AgentProjection    `json:"agents"`
	WorkspaceFiles []store.WorkspaceFileEntry `json:"workspaceFiles"`
	Chats          []store.ChatThread         `json:"chats"`
	Skills         []store.SkillPackRef       `json:"skills"`
}

// sectionOf is the named section of a registration, or nil for a name this
// server does not know.
func sectionOf(name string, registration store.DaemonRegistration) any {
	switch name {
	case "device":
		return deviceSection{registration.AgentProfiles, registration.ProviderHealth}
	case "workspace":
		return workspaceSection{registration.Assets, registration.Agents, registration.WorkspaceFiles, registration.Chats, registration.Skills}
	}
	return nil
}

// maxSectionsPerDevice bounds what is kept of one device: a section per
// workspace, a few for its agents. The least recently used goes first.
const maxSectionsPerDevice = 256

// registrationSections keeps devices' registration sections, as JSON, by
// device and by section name and digest.
type registrationSections struct {
	mu      sync.Mutex
	devices map[string]map[string]*keptSection
	clock   uint64
}

type keptSection struct {
	data []byte
	used uint64
}

// registrationNeededError is a registration leaving out sections the server
// does not have.
type registrationNeededError struct {
	sections []string
}

func (e *registrationNeededError) Error() string {
	return fmt.Sprintf("registration left out sections the server does not have: %s", strings.Join(e.sections, ", "))
}

func registrationNeededEnvelope(id string, sections []string) wsEnvelope {
	payload, _ := json.Marshal(wsRegistrationNeededPayload{Sections: sections})
	return wsEnvelope{Type: wsRegistrationNeededType, ID: id, Payload: payload}
}

// fill puts back the sections the registration left out, from what the
// device sent before. It returns those the server does not have, leaving
// the registration as it was.
func (s *registrationSections) fill(deviceID string, registration *store.DaemonRegistration) error {
	if len(registration.OmittedSections) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.devices[deviceID]
	var found [][]byte
	var missing []string
	for _, name := range registration.OmittedSections {
		section := kept[name+":"+registration.Sections[name]]
		if section == nil || registration.Sections[name] == "" || sectionOf(name, store.DaemonRegistration{}) == nil {
			missing = append(missing, name)
			continue
		}
		s.clock++
		section.used = s.clock
		found = append(found, section.data)
	}
	if len(missing) > 0 {
		return &registrationNeededError{sections: missing}
	}
	for _, data := range found {
		if err := json.Unmarshal(data, registration); err != nil {
			return err
		}
	}
	registration.OmittedSections = nil
	return nil
}

// keep remembers the sections a registration carries, under the digests the
// device gave them.
func (s *registrationSections) keep(deviceID string, registration store.DaemonRegistration) {
	if deviceID == "" || len(registration.Sections) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.devices == nil {
		s.devices = map[string]map[string]*keptSection{}
	}
	kept := s.devices[deviceID]
	if kept == nil {
		kept = map[string]*keptSection{}
		s.devices[deviceID] = kept
	}
	for name, digest := range registration.Sections {
		section := sectionOf(name, registration)
		if section == nil || digest == "" {
			continue
		}
		s.clock++
		key := name + ":" + digest
		if existing := kept[key]; existing != nil {
			existing.used = s.clock
			continue
		}
		data, err := json.Marshal(section)
		if err != nil {
			continue
		}
		kept[key] = &keptSection{data: data, used: s.clock}
	}
	for len(kept) > maxSectionsPerDevice {
		var oldest string
		for key, section := range kept {
			if oldest == "" || section.used < kept[oldest].used {
				oldest = key
			}
		}
		delete(kept, oldest)
	}
}
