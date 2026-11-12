package assistant

import (
	"context"
	"errors"
	"log"
	"net/http"
	"slices"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Moving the assistant to another of the person's computers (§2): a new
// folder there with its AGENTS.md and, while the old computer is online,
// its routing notes, notes and log carried over; or, on a computer it lived
// on before, the folder it left there, taken up again. The assistant's
// records stay on the server, and it is the same assistant: settings,
// memory, tasks and rules. The folder it leaves becomes an archived project
// of the person's (nothing in it is deleted) and is listed among its former
// workspaces, where its earlier conversations stay readable.

// Bounds on what moving carries over from the old folder.
const (
	carriedFilesMax  = 500
	carriedBytesMax  = 4 << 20
	carriedDepthMax  = 4
	carryReadTimeout = 30 * time.Second
)

// MoveHome moves the person's assistant to their device deviceID (see
// above); moving to the computer it is on changes nothing.
func (s *Service) MoveHome(ctx context.Context, account *store.User, agent store.PersonalAgent, deviceID string) (store.PersonalAgent, error) {
	owned, err := store.AvailableOwnedDevices(ctx, s.store, account.ID)
	if err != nil {
		return agent, err
	}
	if !slices.Contains(owned, deviceID) {
		return agent, &personalagent.Refusal{Status: http.StatusNotFound, Err: errors.New("device not found")}
	}
	if deviceID == agent.HomeDeviceID {
		return agent, nil
	}
	old, oldErr := s.store.GetWorkspace(ctx, agent.WorkspaceID)
	workspace, err := s.formerFolder(ctx, agent, deviceID)
	if err != nil {
		return agent, err
	}
	if workspace.ID == "" {
		name := old.Name
		if oldErr != nil || name == "" {
			name = assistantFolderName(agent.Settings, account.Locale)
		}
		var carried []personalagent.WorkspaceFile
		if oldErr == nil {
			carried = s.carriedFiles(ctx, old)
		}
		if workspace, err = s.createFolder(ctx, account.ID, deviceID, name, carried); err != nil {
			return agent, err
		}
	}
	moved, err := s.store.MovePersonalAgentHome(ctx, agent.ID, workspace.ID, deviceID)
	if err != nil {
		return agent, err
	}
	if oldErr == nil {
		s.retireWorkspace(ctx, old)
	}
	return moved, nil
}

// formerFolder takes up again the folder the assistant left on
// the device, when it is still registered there: the assistant's workspace
// once more, unarchived. Nothing (an empty projection) when there is none.
func (s *Service) formerFolder(ctx context.Context, agent store.PersonalAgent, deviceID string) (store.WorkspaceProjection, error) {
	for index := len(agent.FormerWorkspaceIDs) - 1; index >= 0; index-- {
		workspace, err := s.store.GetWorkspace(ctx, agent.FormerWorkspaceIDs[index])
		if errors.Is(err, store.ErrNotFound) || (err == nil && workspace.DeviceID != deviceID) {
			continue
		}
		if err != nil {
			return store.WorkspaceProjection{}, err
		}
		if workspace.UnavailableOnDevice != nil {
			// Its folder is gone from the device: make a new one.
			continue
		}
		if err := s.store.SetWorkspaceKind(ctx, workspace.ID, store.WorkspaceKindPersonalAgent); err != nil {
			return store.WorkspaceProjection{}, err
		}
		if workspace, err = s.store.SetWorkspaceArchived(ctx, workspace.ID, time.Time{}); err != nil {
			return store.WorkspaceProjection{}, err
		}
		s.server.WorkspacesChanged()
		return workspace, nil
	}
	return store.WorkspaceProjection{}, nil
}

// retireWorkspace makes the assistant's former workspace an
// archived project of its owner's.
func (s *Service) retireWorkspace(ctx context.Context, workspace store.WorkspaceProjection) {
	if err := s.store.SetWorkspaceKind(ctx, workspace.ID, store.WorkspaceKindProject); err != nil {
		log.Printf("retire the assistant's former workspace %s: %v", workspace.ID, err)
		return
	}
	if _, err := s.store.SetWorkspaceArchived(ctx, workspace.ID, time.Now().UTC()); err != nil {
		log.Printf("archive the assistant's former workspace %s: %v", workspace.ID, err)
	}
	s.server.WorkspacesChanged()
}

// carriedFiles reads what moving carries over from the old
// folder: the text files under personalagent.HomeFolders, whole, within
// the bounds above. Nothing when its computer is offline.
func (s *Service) carriedFiles(ctx context.Context, workspace store.WorkspaceProjection) []personalagent.WorkspaceFile {
	if workspace.DeviceID == "" || !s.devices.Connected(workspace.DeviceID) {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, carryReadTimeout)
	defer cancel()
	files, total := []personalagent.WorkspaceFile{}, 0
	var walk func(folder string, depth int)
	walk = func(folder string, depth int) {
		entries, err := s.devices.ListWorkspaceTree(ctx, workspace, folder)
		if err != nil {
			return
		}
		for _, entry := range entries {
			path := folder + "/" + entry.Name
			switch {
			case len(files) >= carriedFilesMax || ctx.Err() != nil:
				return
			case entry.IsDirectory:
				if depth < carriedDepthMax {
					walk(path, depth+1)
				}
			case store.RelativeFolderPath(path) && total+int(entry.Size) <= carriedBytesMax:
				read, err := s.devices.ReadWorkspaceFile(ctx, workspace, path)
				if err != nil || read.Truncated || total+len(read.Content) > carriedBytesMax {
					log.Printf("move the assistant: %s of %s stays behind", path, workspace.ID)
					continue
				}
				total += len(read.Content)
				files = append(files, personalagent.WorkspaceFile{Path: path, Content: read.Content})
			}
		}
	}
	for _, folder := range personalagent.HomeFolders {
		walk(folder, 1)
	}
	return files
}
