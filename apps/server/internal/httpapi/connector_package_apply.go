package httpapi

import (
	"context"
	"errors"
	"log"
	"sort"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Enabling a package on a device fetches the upstream bundle through another
// device, installs the repository tools and the extension: round trips that
// take minutes, far beyond a request. A request therefore only validates and
// records the selection, with each device pending; the work runs in the
// background (runConnectorPackageApply), one run at a time per package, and
// each device's progress is kept on the enablement (States) for the Web page
// and the MCP tool to read.

// connectorPackageResumeGrace is how long after a start an interrupted apply
// waits for the devices to reconnect before it takes them up.
var connectorPackageResumeGrace = 30 * time.Second

func connectorPackageApplyKey(ownerUserID, kind string) string { return ownerUserID + "/" + kind }

// updateConnectorPackage changes an existing enablement under the record
// lock; change reports whether to save. A missing enablement is ErrNotFound.
func (s *Server) updateConnectorPackage(ctx context.Context, ownerUserID, kind string, change func(*store.ConnectorPackageEnablement) bool) error {
	s.packageRecordMu.Lock()
	defer s.packageRecordMu.Unlock()
	record, err := s.store.GetConnectorPackage(ctx, ownerUserID, kind)
	if err != nil {
		return err
	}
	if !change(&record) {
		return nil
	}
	record.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	return s.store.SaveConnectorPackage(ctx, record)
}

// selectConnectorPackageDevices records the selection, every device it
// changes pending. It touches no device.
func (s *Server) selectConnectorPackageDevices(ctx context.Context, ownerUserID string, descriptor store.ConnectorDescriptor, wanted []string) error {
	s.packageRecordMu.Lock()
	defer s.packageRecordMu.Unlock()
	record, err := s.store.GetConnectorPackage(ctx, ownerUserID, descriptor.Kind)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	installed := map[string]bool{}
	for _, id := range record.Devices {
		installed[id] = true
	}
	wantedSet := map[string]bool{}
	states := map[string]store.ConnectorPackageProgress{}
	for _, id := range wanted {
		wantedSet[id] = true
		if !installed[id] {
			states[id] = store.ConnectorPackageProgress{State: store.ConnectorPackageDeviceStatePending, UpdatedAt: now}
		}
	}
	for _, id := range record.Devices {
		if !wantedSet[id] {
			states[id] = store.ConnectorPackageProgress{State: store.ConnectorPackageDeviceStatePending, UpdatedAt: now}
		}
	}
	record.OwnerUserID, record.Kind = ownerUserID, descriptor.Kind
	record.ExtensionID = descriptor.Extension.ID
	record.Selected = append([]string(nil), wanted...)
	record.States = states
	record.UpdatedAt = now
	return s.store.SaveConnectorPackage(ctx, record)
}

// startConnectorPackageApply runs the package's pending devices in the
// background. Runs of one package queue behind each other, and a run applies
// whatever is pending when it starts, so a later call finds nothing left.
func (s *Server) startConnectorPackageApply(ownerUserID, kind string) {
	s.hub.work.Go(func() { s.runConnectorPackageApply(s.hub.work.ctx, ownerUserID, kind) })
}

// resumeConnectorPackageApplies takes up the applies a restart interrupted,
// once the devices had time to reconnect.
func (s *Server) resumeConnectorPackageApplies(ctx context.Context) {
	items, err := s.store.ListAllConnectorPackages(ctx)
	if err != nil {
		log.Printf("connector packages: resume: %v", err)
		return
	}
	var unfinished []store.ConnectorPackageEnablement
	for _, item := range items {
		if item.Unfinished() {
			unfinished = append(unfinished, item)
		}
	}
	if len(unfinished) == 0 {
		return
	}
	s.hub.work.Go(func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(connectorPackageResumeGrace):
		}
		for _, item := range unfinished {
			s.runConnectorPackageApply(ctx, item.OwnerUserID, item.Kind)
		}
	})
}

type connectorPackageStep struct {
	deviceID string
	add      bool
}

// claimConnectorPackageSteps marks the pending devices installing and says
// what each needs. A device left installing by a stopped run counts as
// pending; one whose selection no longer asks for a change is cleared.
func (s *Server) claimConnectorPackageSteps(ctx context.Context, ownerUserID, kind string) (store.ConnectorPackageEnablement, []connectorPackageStep, error) {
	var steps []connectorPackageStep
	var claimed store.ConnectorPackageEnablement
	err := s.updateConnectorPackage(ctx, ownerUserID, kind, func(record *store.ConnectorPackageEnablement) bool {
		selected := map[string]bool{}
		for _, id := range record.Selected {
			selected[id] = true
		}
		installed := map[string]bool{}
		for _, id := range record.Devices {
			installed[id] = true
		}
		now := time.Now().UTC().Format(time.RFC3339)
		changed := false
		for id, progress := range record.States {
			if progress.State != store.ConnectorPackageDeviceStatePending && progress.State != store.ConnectorPackageDeviceStateInstalling {
				continue
			}
			changed = true
			switch {
			case selected[id] && !installed[id]:
				steps = append(steps, connectorPackageStep{deviceID: id, add: true})
			case !selected[id] && installed[id]:
				steps = append(steps, connectorPackageStep{deviceID: id})
			default:
				delete(record.States, id)
				continue
			}
			record.States[id] = store.ConnectorPackageProgress{State: store.ConnectorPackageDeviceStateInstalling, UpdatedAt: now}
		}
		claimed = *record
		return changed
	})
	sort.Slice(steps, func(i, j int) bool { return steps[i].deviceID < steps[j].deviceID })
	return claimed, steps, err
}

// finishConnectorPackageStep records one device's outcome unless a newer
// selection took the device over meanwhile (it is pending again then) or the
// server is stopping (the step is taken up again after the restart).
func (s *Server) finishConnectorPackageStep(ctx context.Context, ownerUserID, kind string, step connectorPackageStep, stepErr error) {
	if ctx.Err() != nil {
		return
	}
	err := s.updateConnectorPackage(context.WithoutCancel(ctx), ownerUserID, kind, func(record *store.ConnectorPackageEnablement) bool {
		if record.States[step.deviceID].State != store.ConnectorPackageDeviceStateInstalling {
			return false
		}
		now := time.Now().UTC().Format(time.RFC3339)
		if stepErr != nil {
			record.States[step.deviceID] = store.ConnectorPackageProgress{State: store.ConnectorPackageDeviceStateFailed, Error: stepErr.Error(), UpdatedAt: now}
			return true
		}
		delete(record.States, step.deviceID)
		kept := record.Devices[:0:0]
		for _, id := range record.Devices {
			if id != step.deviceID {
				kept = append(kept, id)
			}
		}
		if step.add {
			kept = append(kept, step.deviceID)
		}
		record.Devices = kept
		return true
	})
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		log.Printf("connector package %s: record %s: %v", kind, step.deviceID, err)
	}
	s.projectionsChanged("", fieldConnectorPackages)
}

// runConnectorPackageApply applies the package's pending devices until none
// is left. It is safe to run again: installs repeat.
func (s *Server) runConnectorPackageApply(ctx context.Context, ownerUserID, kind string) {
	unlock := s.packageApplies.lock(connectorPackageApplyKey(ownerUserID, kind))
	defer unlock()
	for ctx.Err() == nil {
		record, steps, err := s.claimConnectorPackageSteps(ctx, ownerUserID, kind)
		if err != nil {
			if !errors.Is(err, store.ErrNotFound) {
				log.Printf("connector package %s: claim: %v", kind, err)
			}
			return
		}
		if len(steps) == 0 {
			return
		}
		s.projectionsChanged("", fieldConnectorPackages)
		descriptor, _, err := s.packageDescriptorForOwner(ctx, ownerUserID, kind)
		if err != nil {
			for _, step := range steps {
				s.finishConnectorPackageStep(ctx, ownerUserID, kind, step, errors.New("the package is not offered by any of your devices"))
			}
			continue
		}
		s.applyConnectorPackageSteps(ctx, record, descriptor, steps)
	}
}

func (s *Server) applyConnectorPackageSteps(ctx context.Context, record store.ConnectorPackageEnablement, descriptor store.ConnectorDescriptor, steps []connectorPackageStep) {
	owner, kind := record.OwnerUserID, descriptor.Kind
	var additions []connectorPackageStep
	var uninstalled bool
	for _, step := range steps {
		if step.add {
			additions = append(additions, step)
			continue
		}
		s.finishConnectorPackageStep(ctx, owner, kind, step, s.removeConnectorPackageFromDevice(ctx, record, step.deviceID))
		uninstalled = true
	}
	if uninstalled {
		s.syncConnectorToolVersions(ctx)
		s.projectionsChanged("", fieldDeviceTools)
	}
	if len(additions) == 0 {
		return
	}
	s.repoMu.Lock()
	defer s.repoMu.Unlock()
	failAll := func(err error) {
		for _, step := range additions {
			s.finishConnectorPackageStep(ctx, owner, kind, step, err)
		}
	}
	reader, err := s.connectorPackageReaderFor(ctx, owner, descriptor, additions[0].deviceID)
	if err != nil {
		failAll(err)
		return
	}
	repository, err := s.followConnectorPackageBundle(ctx, owner, descriptor, reader)
	if err != nil {
		failAll(err)
		return
	}
	_ = s.updateConnectorPackage(ctx, owner, kind, func(current *store.ConnectorPackageEnablement) bool {
		current.RepositoryID = repository.ID
		current.ExtensionID = descriptor.Extension.ID
		return true
	})
	for _, step := range additions {
		err := s.enableConnectorPackageDevice(ctx, step.deviceID, descriptor, repository)
		if err != nil && ctx.Err() == nil {
			_ = s.uninstallPackageTools(context.WithoutCancel(ctx), step.deviceID, repository)
		}
		s.finishConnectorPackageStep(ctx, owner, kind, step, err)
	}
}

func (s *Server) removeConnectorPackageFromDevice(ctx context.Context, record store.ConnectorPackageEnablement, deviceID string) error {
	if record.RepositoryID == "" {
		return nil
	}
	if s.hub.connectionFor(deviceID) == nil {
		return errors.New("the device is offline; reconnect it and remove the package again")
	}
	repository, err := s.store.GetSkillRepository(ctx, record.RepositoryID)
	if err != nil {
		return err
	}
	return s.uninstallPackageTools(ctx, deviceID, repository)
}

// removeConnectorPackage uninstalls the package from the devices it is on
// and deletes the enablement, after any apply under way.
func (s *Server) removeConnectorPackage(ctx context.Context, ownerUserID string, descriptor store.ConnectorDescriptor) ([]string, error) {
	unlock := s.packageApplies.lock(connectorPackageApplyKey(ownerUserID, descriptor.Kind))
	defer unlock()
	record, err := s.store.GetConnectorPackage(ctx, ownerUserID, descriptor.Kind)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := s.disableConnectorPackageDevices(ctx, ownerUserID, descriptor, record.Devices); err != nil {
		return nil, err
	}
	if err := s.store.DeleteConnectorPackage(ctx, ownerUserID, descriptor.Kind); err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	s.projectionsChanged("", fieldConnectorPackages)
	return record.Devices, nil
}
