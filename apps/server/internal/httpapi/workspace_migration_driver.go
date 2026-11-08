package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The driver of workspace moves (DEV-146,
// docs/devlog/DEV-146-workspace-migration.md): a background job takes each
// move whose lease ran out and runs its current step, against the source
// and target devices' connections.

const (
	// migrationLease is how long a running step holds its job; a step that
	// takes longer renews it.
	migrationLease = 2 * time.Minute
	// migrationRetryAfter is when a step that waits on a device is tried
	// again (sooner when a device connects).
	migrationRetryAfter = 10 * time.Second
	// migrationWorkTimeout bounds a device's long step (verify, rescan,
	// activate): hashing a large folder takes a while.
	migrationWorkTimeout = 2 * time.Hour
	// migrationStall is how long a transfer may send no news before it is
	// started again.
	migrationStall = 5 * time.Minute
	// migrationReceivedGrace is how long the target's "received" may come
	// after the stream closed.
	migrationReceivedGrace = 30 * time.Second
	// migrationMaxFailedTransfers ends a move whose transfers keep failing
	// without moving a byte.
	migrationMaxFailedTransfers = 8
	// migrationMaxVerifyMismatches ends a move whose copy keeps differing.
	migrationMaxVerifyMismatches = 3
	// migrationProgressSaveEvery throttles progress writes.
	migrationProgressSaveEvery = time.Second
	// migrationPollInterval is how often the driver looks for due jobs.
	migrationPollInterval = 5 * time.Second
)

// migrationAskTimeout bounds a short question to a device (scan, check,
// transfer, retire, abort): a worker that does not answer within it does
// not know the message. Tests shorten it.
var migrationAskTimeout = 30 * time.Second

// Reason codes the Web localizes (WorkspaceMigration.reasonCode).
const (
	migrationReasonDeviceOffline   = "device_offline"
	migrationReasonWorkerOutdated  = "worker_outdated"
	migrationReasonPathTaken       = "target_path_taken"
	migrationReasonPathUnavailable = "target_path_unavailable"
	migrationReasonNoSpace         = "not_enough_space"
	migrationReasonBusy            = "workspace_busy"
	migrationReasonRefused         = "device_refused"
	migrationReasonRetrying        = "transfer_retrying"
	migrationReasonTransferFailed  = "transfer_failed"
	migrationReasonVerifyMismatch  = "verify_mismatch"
	migrationReasonCanceled        = "canceled_by_person"
)

// workspaceMigrationRuntime is what the driver keeps in memory: which jobs
// run in this process, the news their transfers send and their streams.
type workspaceMigrationRuntime struct {
	once      sync.Once
	kicks     chan struct{}
	mu        sync.Mutex
	running   map[string]bool
	listeners map[string]*migrationListener
	streams   migrationStreams
}

func (r *workspaceMigrationRuntime) init() {
	r.once.Do(func() {
		r.kicks = make(chan struct{}, 1)
		r.running = map[string]bool{}
		r.listeners = map[string]*migrationListener{}
	})
}

// kick has the driver look for due jobs now.
func (r *workspaceMigrationRuntime) kick() {
	r.init()
	select {
	case r.kicks <- struct{}{}:
	default:
	}
}

func (r *workspaceMigrationRuntime) kicked() <-chan struct{} {
	r.init()
	return r.kicks
}

func (r *workspaceMigrationRuntime) begin(id string) bool {
	r.init()
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.running[id] {
		return false
	}
	r.running[id] = true
	return true
}

func (r *workspaceMigrationRuntime) end(id string) {
	r.mu.Lock()
	delete(r.running, id)
	r.mu.Unlock()
	r.kick()
}

// migrationListener gathers a transfer's news without ever blocking the
// device's read loop: the latest progress of each side, and every end.
type migrationListener struct {
	source, target string
	notify         chan struct{}
	mu             sync.Mutex
	latest         map[string]wsWorkspaceMigrationProgressPayload
	ends           []wsWorkspaceMigrationProgressPayload
}

func (r *workspaceMigrationRuntime) listen(id, source, target string) (*migrationListener, func()) {
	r.init()
	listener := &migrationListener{source: source, target: target, notify: make(chan struct{}, 1), latest: map[string]wsWorkspaceMigrationProgressPayload{}}
	r.mu.Lock()
	r.listeners[id] = listener
	r.mu.Unlock()
	return listener, func() {
		r.mu.Lock()
		if r.listeners[id] == listener {
			delete(r.listeners, id)
		}
		r.mu.Unlock()
	}
}

// deliver hands deviceID's news to the transfer that waits for it; news of
// another device's role, or that no transfer waits for, is dropped.
func (r *workspaceMigrationRuntime) deliver(deviceID string, news wsWorkspaceMigrationProgressPayload) {
	r.init()
	r.mu.Lock()
	listener := r.listeners[news.MigrationID]
	r.mu.Unlock()
	if listener == nil {
		return
	}
	if (news.Role == "source" && deviceID != listener.source) || (news.Role == "target" && deviceID != listener.target) ||
		(news.Role != "source" && news.Role != "target") {
		return
	}
	listener.mu.Lock()
	switch news.Phase {
	case "received", "sent", "failed":
		listener.ends = append(listener.ends, news)
	default:
		listener.latest[news.Role] = news
	}
	listener.mu.Unlock()
	select {
	case listener.notify <- struct{}{}:
	default:
	}
}

func (l *migrationListener) take() (map[string]wsWorkspaceMigrationProgressPayload, []wsWorkspaceMigrationProgressPayload) {
	l.mu.Lock()
	defer l.mu.Unlock()
	latest, ends := l.latest, l.ends
	l.latest, l.ends = map[string]wsWorkspaceMigrationProgressPayload{}, nil
	return latest, ends
}

func (c *daemonConnection) onWorkspaceMigrationProgress(_ context.Context, envelope wsEnvelope) error {
	var news wsWorkspaceMigrationProgressPayload
	if err := decodeWebSocketPayload(envelope.Payload, &news); err != nil {
		return err
	}
	if envelope.ID != "" {
		c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
	}
	if deviceID, _ := c.registrationSnapshot(); deviceID != "" {
		c.hub.migrations.deliver(deviceID, news)
	}
	return nil
}

// runWorkspaceMigrations is the background job.
func (s *Server) runWorkspaceMigrations(ctx context.Context) {
	everyFromNow(ctx, migrationPollInterval, s.hub.migrations.kicked(), s.drainWorkspaceMigrations)
	s.hub.migrations.streams.closeAll()
}

func (s *Server) drainWorkspaceMigrations(ctx context.Context) {
	due, err := s.store.DueWorkspaceMigrations(ctx, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("list due workspace migrations: %v", err)
		}
		return
	}
	for _, record := range due {
		if !s.hub.migrations.begin(record.ID) {
			continue
		}
		if !s.hub.work.Go(func() {
			defer s.hub.migrations.end(record.ID)
			s.advanceWorkspaceMigration(s.hub.work.ctx, record)
		}) {
			s.hub.migrations.end(record.ID)
		}
	}
}

// migrationJob runs one step of a job.
type migrationJob struct {
	s      *Server
	record store.WorkspaceMigrationRecord
	// announced is the state and step last told to clients.
	announced string
}

func (s *Server) advanceWorkspaceMigration(ctx context.Context, record store.WorkspaceMigrationRecord) {
	job := &migrationJob{s: s, record: record, announced: record.State + "/" + record.Step}
	job.record.LeaseUntil = leaseFromNow(migrationLease)
	if err := job.save(ctx); err != nil {
		return
	}
	if job.record.CancelRequested {
		job.cancel(ctx)
		return
	}
	switch job.record.State {
	case store.WorkspaceMigrationPreflight:
		job.preflight(ctx)
	case store.WorkspaceMigrationCopying:
		job.copy(ctx)
	case store.WorkspaceMigrationVerifying:
		job.verify(ctx)
	case store.WorkspaceMigrationActivating:
		job.activate(ctx)
	case store.WorkspaceMigrationRetiring:
		job.retire(ctx)
	}
}

func leaseFromNow(after time.Duration) string {
	return time.Now().Add(after).UTC().Format(time.RFC3339Nano)
}

// save writes the job and tells clients when what they show changed.
func (j *migrationJob) save(ctx context.Context) error {
	saved, err := j.s.store.SaveWorkspaceMigration(ctx, j.record)
	if err != nil {
		if !errors.Is(err, store.ErrWorkspaceMigrationRevision) && ctx.Err() == nil {
			log.Printf("workspace migration %s: save %s: %v", j.record.ID, j.record.State, err)
		}
		return err
	}
	j.record = saved
	j.s.projectionsChanged("", fieldWorkspaces)
	return nil
}

// next moves the job to state at step and has the driver take it up again
// at once.
func (j *migrationJob) next(ctx context.Context, state, step string) error {
	j.record.State, j.record.Step = state, step
	j.record.Reason, j.record.ReasonCode, j.record.WaitingFor, j.record.LeaseUntil = "", "", "", ""
	if err := j.save(ctx); err != nil {
		return err
	}
	j.s.hub.migrations.kick()
	return nil
}

// wait records why the job cannot go on now and when to try again.
func (j *migrationJob) wait(ctx context.Context, code, waitingFor, reason string, after time.Duration) {
	j.record.Reason, j.record.ReasonCode, j.record.WaitingFor = reason, code, waitingFor
	j.record.LeaseUntil = leaseFromNow(after)
	_ = j.save(ctx)
}

// fail ends the job. Before the switch nothing changed on the source; the
// target's partial copy is removed when its device can be reached.
func (j *migrationJob) fail(ctx context.Context, code, reason string) {
	if j.record.State == store.WorkspaceMigrationCopying || j.record.State == store.WorkspaceMigrationVerifying {
		if target := j.s.hub.connectionFor(j.record.TargetDeviceID); target != nil {
			if err := j.abortTarget(ctx, target); err != nil {
				log.Printf("workspace migration %s: removing the partial copy failed: %v", j.record.ID, err)
			}
		}
	}
	j.record.State, j.record.Step = store.WorkspaceMigrationFailed, "done"
	j.record.Reason, j.record.ReasonCode, j.record.WaitingFor, j.record.LeaseUntil = reason, code, "", ""
	if j.save(ctx) == nil {
		log.Printf("workspace migration %s of %s failed: %s (%s)", j.record.ID, j.record.WorkspaceID, reason, code)
	}
}

func (j *migrationJob) sourceLabel() string {
	return cmpOr(j.record.SourceDeviceLabel, "The source device")
}
func (j *migrationJob) targetLabel() string {
	return cmpOr(j.record.TargetDeviceLabel, "The target device")
}

// device is the connection of the source or the target, nil (and the job
// waiting) while it is offline.
func (j *migrationJob) device(ctx context.Context, role string) *daemonConnection {
	deviceID, label, waiting := j.record.SourceDeviceID, j.sourceLabel(), "source_device"
	if role == "target" {
		deviceID, label, waiting = j.record.TargetDeviceID, j.targetLabel(), "target_device"
	}
	if connection := j.s.hub.connectionFor(deviceID); connection != nil {
		return connection
	}
	j.wait(ctx, migrationReasonDeviceOffline, waiting, fmt.Sprintf("Waiting for %s to come online.", label), migrationRetryAfter)
	return nil
}

// errMigrationRefused is a device's refusal, read by the person as it is.
type errMigrationRefused struct{ message string }

func (e errMigrationRefused) Error() string { return e.message }

// askDevice sends request and waits up to timeout for the device's answer.
func askDevice[Resp deviceReply](ctx context.Context, c *daemonConnection, requestType string, request any, timeout time.Duration) (Resp, error) {
	var zero Resp
	payload, err := json.Marshal(request)
	if err != nil {
		return zero, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	value, err := daemonRequest[Resp](ctx, c, requestType, payload)
	if err != nil {
		return zero, err
	}
	if refusal := value.refusal(); refusal != nil {
		return zero, errMigrationRefused{refusal.Error()}
	}
	return value, nil
}

// handle settles a failed device request: a refusal or (for a short
// question) no answer at all ends the job, anything else waits.
func (j *migrationJob) handle(ctx context.Context, err error, role string, short bool) {
	label, waiting := j.sourceLabel(), "source_device"
	if role == "target" {
		label, waiting = j.targetLabel(), "target_device"
	}
	var refused errMigrationRefused
	switch {
	case ctx.Err() != nil:
	case errors.As(err, &refused):
		j.fail(ctx, migrationReasonRefused, fmt.Sprintf("%s: %s", label, refused.message))
	case short && isDeviceTimeout(err):
		j.fail(ctx, migrationReasonWorkerOutdated, fmt.Sprintf("Update the worker on %s, then move the workspace again.", label))
	default:
		j.wait(ctx, migrationReasonDeviceOffline, waiting, fmt.Sprintf("Waiting for %s: %v", label, err), migrationRetryAfter)
	}
}

func (j *migrationJob) nativeSessions(ctx context.Context) ([]wsNativeSessionRef, error) {
	refs, err := j.s.store.WorkspaceNativeSessions(ctx, j.record.WorkspaceID)
	if err != nil {
		return nil, err
	}
	sessions := make([]wsNativeSessionRef, 0, len(refs))
	for _, ref := range refs {
		sessions = append(sessions, wsNativeSessionRef{Provider: ref.Provider, ID: ref.NativeSessionID})
	}
	return sessions, nil
}

// keepLease renews the job's lease while a long step runs and cancels its
// context when the person cancels the job meanwhile.
func (j *migrationJob) keepLease(ctx context.Context) (context.Context, func()) {
	ctx, cancel := context.WithCancel(ctx)
	id := j.record.ID
	go func() {
		ticker := time.NewTicker(migrationLease / 4)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				current, err := j.s.store.RenewWorkspaceMigrationLease(ctx, id, leaseFromNow(migrationLease))
				if err == nil && current.CancelRequested {
					cancel()
					return
				}
			}
		}
	}()
	return ctx, cancel
}

func (j *migrationJob) preflight(ctx context.Context) {
	workspace, err := j.s.store.GetWorkspace(ctx, j.record.WorkspaceID)
	if err != nil {
		j.fail(ctx, "", "The workspace no longer exists.")
		return
	}
	if workspace.DeviceID != j.record.SourceDeviceID {
		j.fail(ctx, "", "The workspace changed device meanwhile. Start the move again.")
		return
	}
	j.record.Step = "checking"
	blockers, err := j.s.store.WorkspaceMigrationBlockers(ctx, j.record.WorkspaceID)
	if err != nil {
		j.wait(ctx, "", "", err.Error(), migrationRetryAfter)
		return
	}
	if len(blockers) > 0 {
		j.record.Blockers = blockers
		j.fail(ctx, migrationReasonBusy, "Finish or stop the work listed first, then move the workspace again.")
		return
	}
	if err := j.s.targetFolderFree(ctx, j.record); err != nil {
		j.fail(ctx, migrationReasonPathTaken, err.Error())
		return
	}
	source := j.device(ctx, "source")
	if source == nil {
		return
	}
	target := j.device(ctx, "target")
	if target == nil {
		return
	}
	sessions, err := j.nativeSessions(ctx)
	if err != nil {
		j.wait(ctx, "", "", err.Error(), migrationRetryAfter)
		return
	}
	j.record.Step = "scanning"
	_ = j.save(ctx)
	scanned, err := askDevice[wsWorkspaceMigrationScannedPayload](ctx, source, wsWorkspaceMigrationScanType, wsWorkspaceMigrationScanPayload{
		MigrationID: j.record.ID, WorkspaceID: j.record.WorkspaceID, Path: j.record.SourcePath, NativeSessions: sessions,
	}, migrationAskTimeout)
	if err != nil {
		j.handle(ctx, err, "source", true)
		return
	}
	j.record.TotalFiles, j.record.TotalBytes, j.record.ManifestDigest = scanned.Files, scanned.Bytes, scanned.ManifestDigest
	j.record.Warnings = scanned.Warnings
	j.record.Step = "checking_target"
	_ = j.save(ctx)
	checked, err := askDevice[wsWorkspaceMigrationCheckedPayload](ctx, target, wsWorkspaceMigrationCheckType, wsWorkspaceMigrationCheckPayload{
		MigrationID: j.record.ID, Path: j.record.TargetPath, Bytes: scanned.Bytes,
	}, migrationAskTimeout)
	if err != nil {
		j.handle(ctx, err, "target", true)
		return
	}
	if !checked.OK {
		j.fail(ctx, migrationReasonPathUnavailable, fmt.Sprintf("%s cannot take the folder at %s: %s", j.targetLabel(), j.record.TargetPath, cmpOr(checked.Reason, "the path is not usable")))
		return
	}
	if strings.TrimSpace(checked.Path) != "" {
		j.record.TargetPath = checked.Path
		if err := j.s.targetFolderFree(ctx, j.record); err != nil {
			j.fail(ctx, migrationReasonPathTaken, err.Error())
			return
		}
	}
	if need := scanned.Bytes + scanned.Bytes/20 + 64<<20; checked.FreeBytes < need {
		j.fail(ctx, migrationReasonNoSpace, fmt.Sprintf("%s has %s free; the workspace needs about %s.", j.targetLabel(), byteLabel(checked.FreeBytes), byteLabel(need)))
		return
	}
	notCarried, err := j.s.store.WorkspaceMigrationNotCarried(ctx, j.record.WorkspaceID, j.record.SourceDeviceID, j.record.TargetDeviceID)
	if err != nil {
		j.wait(ctx, "", "", err.Error(), migrationRetryAfter)
		return
	}
	j.record.NotCarried = notCarried
	// The freeze starts: the store refuses it if work started meanwhile.
	if err := j.next(ctx, store.WorkspaceMigrationCopying, "streaming"); err != nil && errors.Is(err, store.ErrWorkspaceBusy) {
		if blockers, listed := j.s.store.WorkspaceMigrationBlockers(ctx, j.record.WorkspaceID); listed == nil {
			j.record.Blockers = blockers
		}
		j.fail(ctx, migrationReasonBusy, "Work started in the workspace meanwhile. Finish or stop it, then move the workspace again.")
		return
	}
	log.Printf("workspace migration %s: %s moves from %s to %s:%s (%d files, %d bytes); frozen",
		j.record.ID, j.record.WorkspaceID, j.record.SourceDeviceID, j.record.TargetDeviceID, j.record.TargetPath, j.record.TotalFiles, j.record.TotalBytes)
}

// targetFolderFree refuses a target folder that is another workspace of the
// target device.
func (s *Server) targetFolderFree(ctx context.Context, record store.WorkspaceMigrationRecord) error {
	workspaces, err := s.store.ListWorkspaces(ctx)
	if err != nil {
		return err
	}
	clean := path.Clean(strings.TrimSpace(record.TargetPath))
	for _, other := range workspaces {
		if other.ID != record.WorkspaceID && other.DeviceID == record.TargetDeviceID && path.Clean(other.LocalPath) == clean {
			return errFolderTaken{name: other.Name, device: cmpOr(record.TargetDeviceLabel, "the target device")}
		}
	}
	return nil
}

func byteLabel(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	value, suffix := float64(bytes), "B"
	for _, next := range []string{"KiB", "MiB", "GiB", "TiB"} {
		if value < unit {
			break
		}
		value, suffix = value/unit, next
	}
	return fmt.Sprintf("%.1f %s", value, suffix)
}

// copy runs one transfer: it opens a stream pair, has both workers dial
// it, and follows their news until the target received everything.
func (j *migrationJob) copy(ctx context.Context) {
	source := j.device(ctx, "source")
	if source == nil {
		return
	}
	target := j.device(ctx, "target")
	if target == nil {
		return
	}
	sessions, err := j.nativeSessions(ctx)
	if err != nil {
		j.wait(ctx, "", "", err.Error(), migrationRetryAfter)
		return
	}
	pairCtx, closePair := context.WithCancel(ctx)
	defer closePair()
	pair, sourceStream, targetStream := j.s.hub.migrations.streams.open(pairCtx, j.record.ID, source, target)
	listener, unlisten := j.s.hub.migrations.listen(j.record.ID, j.record.SourceDeviceID, j.record.TargetDeviceID)
	defer unlisten()
	j.record.Attempts++
	j.record.Step, j.record.Reason, j.record.ReasonCode, j.record.WaitingFor = "streaming", "", "", ""
	j.record.LeaseUntil = leaseFromNow(migrationLease)
	if j.save(ctx) != nil {
		return
	}
	startBytes := j.record.Bytes
	// The target dials first and says HELLO first; both are told before
	// either has to wait long for the other.
	for _, side := range []struct {
		role, stream, path string
		connection         *daemonConnection
	}{
		{"target", targetStream, j.record.TargetPath, target},
		{"source", sourceStream, j.record.SourcePath, source},
	} {
		_, err := askDevice[wsWorkspaceMigrationTransferStartedPayload](ctx, side.connection, wsWorkspaceMigrationTransferType, wsWorkspaceMigrationTransferPayload{
			MigrationID: j.record.ID, Role: side.role, StreamID: side.stream, WorkspaceID: j.record.WorkspaceID, Path: side.path, NativeSessions: sessions,
		}, migrationAskTimeout)
		if err != nil {
			var refused errMigrationRefused
			if errors.As(err, &refused) {
				j.handle(ctx, err, side.role, false)
				return
			}
			j.retry(ctx, fmt.Sprintf("starting the transfer on the %s: %v", side.role, err), startBytes)
			return
		}
	}
	lastSaved, dirty := time.Now(), false
	lastNews := time.Now()
	ticker := time.NewTicker(migrationProgressSaveEvery)
	defer ticker.Stop()
	var grace <-chan time.Time
	pairDone := pair.done
	for {
		select {
		case <-ctx.Done():
			return
		case <-source.done:
			j.retry(ctx, j.sourceLabel()+" disconnected", startBytes)
			return
		case <-target.done:
			j.retry(ctx, j.targetLabel()+" disconnected", startBytes)
			return
		case <-pairDone:
			pairDone = nil
			grace = time.After(migrationReceivedGrace)
		case <-grace:
			j.retry(ctx, "the data stream closed before the target received everything", startBytes)
			return
		case <-listener.notify:
			lastNews = time.Now()
			latest, ends := listener.take()
			if news, ok := latest["target"]; ok {
				j.progress(news)
				dirty = true
			} else if news, ok := latest["source"]; ok && j.record.Bytes == 0 {
				j.record.TotalFiles, j.record.TotalBytes = cmpOrInt(news.TotalFiles, j.record.TotalFiles), cmpOrInt(news.TotalBytes, j.record.TotalBytes)
				dirty = true
			}
			for _, end := range ends {
				switch {
				case end.Role == "target" && end.Phase == "received":
					j.progress(end)
					j.record.ReceivedDigest = end.ManifestDigest
					j.record.FailedAttempts = 0
					// The workers finish their exchange (ACK) and close.
					select {
					case <-pair.ended():
					case <-time.After(migrationReceivedGrace):
					case <-ctx.Done():
						return
					}
					j.next(ctx, store.WorkspaceMigrationVerifying, "verifying_target")
					return
				case end.Phase == "failed":
					j.retry(ctx, fmt.Sprintf("the %s reported: %s", end.Role, cmpOr(end.Error, "the transfer failed")), startBytes)
					return
				}
			}
		case <-ticker.C:
			if time.Since(lastNews) > migrationStall {
				j.retry(ctx, "the transfer sent no news for 5 minutes", startBytes)
				return
			}
			if dirty && time.Since(lastSaved) >= migrationProgressSaveEvery {
				j.record.LeaseUntil = leaseFromNow(migrationLease)
				if j.save(ctx) != nil {
					// Canceled, or changed by another driver: the next run decides.
					return
				}
				lastSaved, dirty = time.Now(), false
				continue
			}
			// Holds the job and hears a cancel at once.
			current, err := j.s.store.RenewWorkspaceMigrationLease(ctx, j.record.ID, leaseFromNow(migrationLease))
			if err == nil && (current.CancelRequested || current.Revision != j.record.Revision) {
				return
			}
		}
	}
}

func (j *migrationJob) progress(news wsWorkspaceMigrationProgressPayload) {
	j.record.Files, j.record.Bytes = news.Files, news.Bytes
	j.record.TotalFiles = cmpOrInt(news.TotalFiles, j.record.TotalFiles)
	j.record.TotalBytes = cmpOrInt(news.TotalBytes, j.record.TotalBytes)
}

func cmpOrInt(value, fallback int64) int64 {
	if value != 0 {
		return value
	}
	return fallback
}

// retry starts the transfer again after a pause; the workers resume, file
// by file. A transfer that keeps failing without moving a byte ends the job.
func (j *migrationJob) retry(ctx context.Context, why string, startBytes int64) {
	if ctx.Err() != nil {
		return
	}
	if j.record.Bytes > startBytes {
		j.record.FailedAttempts = 1
	} else {
		j.record.FailedAttempts++
	}
	if j.record.FailedAttempts >= migrationMaxFailedTransfers {
		j.fail(ctx, migrationReasonTransferFailed, fmt.Sprintf("The transfer failed %d times in a row: %s", j.record.FailedAttempts, why))
		return
	}
	backoff := min(5*time.Second<<max(j.record.FailedAttempts-1, 0), time.Minute)
	log.Printf("workspace migration %s: transfer attempt %d ended (%s); again in %s", j.record.ID, j.record.Attempts, why, backoff)
	j.record.Step = "retrying"
	j.wait(ctx, migrationReasonRetrying, "", "The transfer is starting again: "+why, backoff)
}

func (j *migrationJob) verify(ctx context.Context) {
	target := j.device(ctx, "target")
	if target == nil {
		return
	}
	source := j.device(ctx, "source")
	if source == nil {
		return
	}
	work, done := j.keepLease(ctx)
	defer done()
	verified, err := askDevice[wsWorkspaceMigrationVerifiedPayload](work, target, wsWorkspaceMigrationVerifyType, wsWorkspaceMigrationVerifyPayload{
		MigrationID: j.record.ID, Path: j.record.TargetPath,
	}, migrationWorkTimeout)
	if err != nil {
		if work.Err() != nil && ctx.Err() == nil {
			return
		}
		var refused errMigrationRefused
		if errors.As(err, &refused) {
			// What the target lacks is sent again.
			j.mismatch(ctx, refused.message)
			return
		}
		j.handle(ctx, err, "target", false)
		return
	}
	expected := cmpOr(j.record.ReceivedDigest, j.record.ManifestDigest)
	if !verified.OK || (expected != "" && verified.ManifestDigest != expected) {
		j.mismatch(ctx, strings.Join(verified.Mismatches, ", "))
		return
	}
	j.record.Step = "rescanning"
	_ = j.save(ctx)
	sessions, err := j.nativeSessions(ctx)
	if err != nil {
		j.wait(ctx, "", "", err.Error(), migrationRetryAfter)
		return
	}
	rescanned, err := askDevice[wsWorkspaceMigrationRescannedPayload](work, source, wsWorkspaceMigrationRescanType, wsWorkspaceMigrationRescanPayload{
		MigrationID: j.record.ID, WorkspaceID: j.record.WorkspaceID, Path: j.record.SourcePath, NativeSessions: sessions,
	}, migrationWorkTimeout)
	if err != nil {
		if work.Err() != nil && ctx.Err() == nil {
			return
		}
		j.handle(ctx, err, "source", false)
		return
	}
	if rescanned.Changed {
		// Changed outside Foundry: only the difference is sent.
		j.record.ManifestDigest = rescanned.ManifestDigest
		log.Printf("workspace migration %s: source changed since the transfer (%s); copying the difference", j.record.ID, strings.Join(rescanned.Changes, ", "))
		j.next(ctx, store.WorkspaceMigrationCopying, "copying_changes")
		return
	}
	j.next(ctx, store.WorkspaceMigrationActivating, "activating_target")
}

func (j *migrationJob) mismatch(ctx context.Context, detail string) {
	j.record.VerifyMismatches++
	if j.record.VerifyMismatches >= migrationMaxVerifyMismatches {
		j.fail(ctx, migrationReasonVerifyMismatch, "The copy on the target kept differing from the source: "+cmpOr(detail, "digest mismatch"))
		return
	}
	log.Printf("workspace migration %s: verification differed (%s); copying again", j.record.ID, detail)
	j.next(ctx, store.WorkspaceMigrationCopying, "copying_changes")
}

func (j *migrationJob) activate(ctx context.Context) {
	target := j.device(ctx, "target")
	if target == nil {
		return
	}
	workspace, err := j.s.store.GetWorkspace(ctx, j.record.WorkspaceID)
	if err != nil {
		j.wait(ctx, "", "", err.Error(), migrationRetryAfter)
		return
	}
	sessions, err := j.nativeSessions(ctx)
	if err != nil {
		j.wait(ctx, "", "", err.Error(), migrationRetryAfter)
		return
	}
	work, done := j.keepLease(ctx)
	defer done()
	// The target activates once per job: asked again (a restart), it
	// answers what it did.
	activated, err := askDevice[wsWorkspaceMigrationActivatedPayload](work, target, wsWorkspaceMigrationActivateType, wsWorkspaceMigrationActivatePayload{
		MigrationID: j.record.ID, WorkspaceID: j.record.WorkspaceID, Name: workspace.Name,
		Path: j.record.TargetPath, PreviousPath: j.record.SourcePath, NativeSessions: sessions,
	}, migrationWorkTimeout)
	if err != nil {
		if work.Err() != nil && ctx.Err() == nil {
			return
		}
		var refused errMigrationRefused
		if errors.As(err, &refused) {
			// Past the copy there is no way back: it waits for the device.
			j.wait(ctx, migrationReasonRefused, "target_device", fmt.Sprintf("%s: %s", j.targetLabel(), refused.message), time.Minute)
			return
		}
		j.handle(ctx, err, "target", false)
		return
	}
	registration := activated.Registration
	if registration == nil || registration.Device.ID != j.record.TargetDeviceID || registration.Workspace.ID != j.record.WorkspaceID {
		j.wait(ctx, migrationReasonRefused, "target_device", j.targetLabel()+" answered without the workspace.", time.Minute)
		return
	}
	done()
	moved, err := j.s.store.ActivateWorkspaceMigration(ctx, j.record, store.WorkspaceMigrationActivation{
		TargetPath: registration.Workspace.LocalPath, ExecutionRoot: activated.ExecutionRoot,
		PreviousExecutionRoot: activated.PreviousExecutionRoot,
		// The device's name in Foundry (a rename), not the host name it reports.
		TargetDeviceLabel: cmpOr(j.s.deviceLabels(ctx)[registration.Device.ID], registration.Device.Label),
	})
	if err != nil {
		if !errors.Is(err, store.ErrWorkspaceMigrationRevision) {
			j.wait(ctx, "", "", err.Error(), migrationRetryAfter)
		}
		return
	}
	j.record = moved
	registration.Workspace.DeviceID, registration.Workspace.DeviceLabel = registration.Device.ID, registration.Device.Label
	if err := target.syncRegistration(*registration); err != nil {
		// The target's next hello registers it as well.
		log.Printf("workspace migration %s: registering the workspace on the target: %v", j.record.ID, err)
	}
	j.s.hub.work.Go(func() { target.dispatchQueuedAgentSessions(j.record.WorkspaceID) })
	j.s.projectionsChanged("", workspaceRemovalFields...)
	j.s.feishuBotsChanged(ctx)
	j.s.hub.migrations.kick()
	log.Printf("workspace migration %s: %s now on %s at %s", j.record.ID, j.record.WorkspaceID, j.record.TargetDeviceID, j.record.TargetPath)
}

func (j *migrationJob) retire(ctx context.Context) {
	source := j.s.hub.connectionFor(j.record.SourceDeviceID)
	if source == nil {
		j.wait(ctx, migrationReasonDeviceOffline, "source_device",
			fmt.Sprintf("The workspace runs on %s. %s retires its old copy when it comes online.", j.targetLabel(), j.sourceLabel()), time.Minute)
		return
	}
	_, err := askDevice[wsReplyError](ctx, source, wsWorkspaceMigrationRetireType, wsWorkspaceMigrationRetirePayload{
		MigrationID: j.record.ID, WorkspaceID: j.record.WorkspaceID, TargetDeviceID: j.record.TargetDeviceID,
	}, migrationAskTimeout)
	if err != nil {
		if ctx.Err() == nil {
			j.wait(ctx, migrationReasonDeviceOffline, "source_device", fmt.Sprintf("Waiting for %s to retire the old copy: %v", j.sourceLabel(), err), time.Minute)
		}
		return
	}
	j.record.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	j.next(ctx, store.WorkspaceMigrationComplete, "done")
}

func (j *migrationJob) abortTarget(ctx context.Context, target *daemonConnection) error {
	_, err := askDevice[wsReplyError](ctx, target, wsWorkspaceMigrationAbortType, wsWorkspaceMigrationAbortPayload{
		MigrationID: j.record.ID, Path: j.record.TargetPath,
	}, migrationAskTimeout)
	return err
}

// cancel ends a job the person canceled before the switch: the target's
// partial copy is removed, then the workspace is free again.
func (j *migrationJob) cancel(ctx context.Context) {
	if j.record.State != store.WorkspaceMigrationPreflight {
		target := j.device(ctx, "target")
		if target == nil {
			j.record.Step = "aborting"
			j.wait(ctx, migrationReasonDeviceOffline, "target_device",
				fmt.Sprintf("Waiting for %s to come online to remove the partial copy.", j.targetLabel()), migrationRetryAfter)
			return
		}
		j.record.Step = "aborting"
		_ = j.save(ctx)
		if err := j.abortTarget(ctx, target); err != nil {
			if ctx.Err() == nil {
				j.wait(ctx, migrationReasonRefused, "target_device", fmt.Sprintf("Removing the partial copy on %s: %v", j.targetLabel(), err), migrationRetryAfter)
			}
			return
		}
	}
	j.record.State, j.record.Step = store.WorkspaceMigrationCanceled, "done"
	j.record.Reason, j.record.ReasonCode, j.record.WaitingFor, j.record.LeaseUntil = "", migrationReasonCanceled, "", ""
	if j.save(ctx) == nil {
		log.Printf("workspace migration %s of %s canceled", j.record.ID, j.record.WorkspaceID)
	}
}

// frozenWorkspace is the refusal of new work in a workspace that is being
// moved, or nil.
func frozenWorkspace(workspace store.WorkspaceProjection) error {
	if workspace.Migration == nil || !store.WorkspaceMigrationFrozen(workspace.Migration.State) {
		return nil
	}
	return &statusError{http.StatusConflict, fmt.Errorf("%s is moving to %s: work there waits until the move finishes",
		cmpOr(workspace.Name, "This workspace"), cmpOr(workspace.Migration.TargetDeviceLabel, "another device"))}
}

// movingWorkspace is frozenWorkspace by id; a workspace that cannot be read
// is left to the caller's own checks.
func movingWorkspace(ctx context.Context, db store.Store, workspaceID string) error {
	if workspaceID == "" {
		return nil
	}
	workspace, err := db.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return nil
	}
	return frozenWorkspace(workspace)
}

// refuseWhileMoving refuses changing a workspace (deleting, relocating,
// archiving it) while a move of it is under way.
func refuseWhileMoving(ctx context.Context, db store.Store, workspaceID, what string) error {
	workspace, err := db.GetWorkspace(ctx, workspaceID)
	if err != nil || workspace.Migration == nil || store.WorkspaceMigrationEnded(workspace.Migration.State) {
		return nil
	}
	return &statusError{http.StatusConflict, fmt.Errorf("%s is moving to %s and cannot be %s now. Cancel the move or wait until it finishes",
		cmpOr(workspace.Name, "This workspace"), cmpOr(workspace.Migration.TargetDeviceLabel, "another device"), what)}
}
