package workspacedigest

import (
	"context"
	"errors"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Access is one person's role in one workspace they can read.
type Access struct {
	UserID      string
	WorkspaceID string
	Role        string
}

// Sources reads what digests are compiled from; httpapi implements it.
type Sources interface {
	// Readable lists the workspaces userID can read.
	Readable(ctx context.Context, userID string) ([]Access, error)
	// Readers lists who can read workspaceID.
	Readers(ctx context.Context, workspaceID string) ([]Access, error)
	// Collect gathers what access's person reads of its workspace.
	Collect(ctx context.Context, access Access) (Source, error)
	// Devices lists the devices userID owns.
	Devices(ctx context.Context, userID string) ([]DeviceSource, error)
}

// Service computes, keeps and ranks digests.
type Service struct {
	store   store.WorkspaceDigestStore
	sources Sources
	// Now is the clock; time.Now by default.
	Now func() time.Time
	// Wake, when set, is told each time a summary falls due later, so the
	// caller runs Due then.
	Wake func(at time.Time)
}

// New is a service over st and sources. It holds no state of its own.
func New(st store.WorkspaceDigestStore, sources Sources) *Service {
	return &Service{store: st, sources: sources, Now: time.Now}
}

// FindOptions tune Find.
type FindOptions struct {
	// Limit is how many candidates, at most personalagent.FindWorkspaceLimit
	// (0 for that many).
	Limit int
	// Notes are the assistant's routing notes (cards/<id>.md), by
	// workspace id.
	Notes map[string]string
}

// Find ranks the person's readable, unarchived projects for a request,
// best first, with why each matched (find_workspace).
func (s *Service) Find(ctx context.Context, userID, query string, options FindOptions) ([]store.WorkspaceCandidate, error) {
	records, err := s.Sync(ctx, userID)
	if err != nil {
		return nil, err
	}
	return RankRecords(query, records, options.Notes, s.Now(), options.Limit), nil
}

// Digest is the person's digest of one workspace, brought up to date
// (get_workspace); store.ErrNotFound when they cannot read it.
func (s *Service) Digest(ctx context.Context, userID, workspaceID string) (store.WorkspaceDigest, error) {
	accesses, err := s.sources.Readable(ctx, userID)
	if err != nil {
		return store.WorkspaceDigest{}, err
	}
	for _, access := range accesses {
		if access.WorkspaceID != workspaceID {
			continue
		}
		existing, err := s.store.ListWorkspaceDigests(ctx, userID)
		if err != nil {
			return store.WorkspaceDigest{}, err
		}
		record, err := s.refresh(ctx, access, find(existing, workspaceID))
		return record.Digest, err
	}
	if err := s.store.DeleteWorkspaceDigest(ctx, userID, workspaceID); err != nil {
		return store.WorkspaceDigest{}, err
	}
	return store.WorkspaceDigest{}, store.ErrNotFound
}

// Index is the person's L0 index of devices and projects.
func (s *Service) Index(ctx context.Context, userID string) (string, error) {
	records, err := s.Sync(ctx, userID)
	if err != nil {
		return "", err
	}
	devices, err := s.Devices(ctx, userID)
	if err != nil {
		return "", err
	}
	return Index(digestsOf(records), devices, s.Now()), nil
}

// Devices are the digests of the devices the person owns.
func (s *Service) Devices(ctx context.Context, userID string) ([]store.DeviceDigest, error) {
	sources, err := s.sources.Devices(ctx, userID)
	if err != nil {
		return nil, err
	}
	now := s.Now()
	devices := make([]store.DeviceDigest, 0, len(sources))
	for _, source := range sources {
		devices = append(devices, CompileDevice(source, now))
	}
	return devices, nil
}

// Sync brings every digest of the person up to date with its sources and
// deletes those of workspaces they can no longer read.
func (s *Service) Sync(ctx context.Context, userID string) ([]store.WorkspaceDigestRecord, error) {
	accesses, err := s.sources.Readable(ctx, userID)
	if err != nil {
		return nil, err
	}
	existing, err := s.store.ListWorkspaceDigests(ctx, userID)
	if err != nil {
		return nil, err
	}
	records := make([]store.WorkspaceDigestRecord, 0, len(accesses))
	keep := make([]string, 0, len(accesses))
	for _, access := range accesses {
		record, err := s.refresh(ctx, access, find(existing, access.WorkspaceID))
		if err != nil {
			return nil, err
		}
		records = append(records, record)
		keep = append(keep, access.WorkspaceID)
	}
	if err := s.store.DeleteWorkspaceDigests(ctx, userID, keep); err != nil {
		return nil, err
	}
	return records, nil
}

// Refresh brings every reader's digest of a workspace up to date: what
// observers call when something of it changed.
func (s *Service) Refresh(ctx context.Context, workspaceID string) error {
	readers, err := s.sources.Readers(ctx, workspaceID)
	if err != nil {
		return err
	}
	existing, err := s.store.ListWorkspaceDigestsOf(ctx, workspaceID)
	if err != nil {
		return err
	}
	byUser := map[string]*store.WorkspaceDigestRecord{}
	for i := range existing {
		byUser[existing[i].Digest.UserID] = &existing[i]
	}
	for _, reader := range readers {
		if _, err := s.refresh(ctx, reader, byUser[reader.UserID]); err != nil {
			return err
		}
		delete(byUser, reader.UserID)
	}
	for userID := range byUser {
		if err := s.store.DeleteWorkspaceDigest(ctx, userID, workspaceID); err != nil {
			return err
		}
	}
	return nil
}

// Prime syncs the person's digests and makes every summary that is
// missing or out of date due now: what setting up the assistant does
// (§14). The dispatcher's rate limit spreads them out.
func (s *Service) Prime(ctx context.Context, userID string) error {
	records, err := s.Sync(ctx, userID)
	if err != nil {
		return err
	}
	now := formatTime(s.Now())
	for _, record := range records {
		if record.Digest.Dirty && record.SummarySessionID == "" {
			if err := s.store.ScheduleWorkspaceDigestSummary(ctx, record.Digest.UserID, record.Digest.WorkspaceID, now); err != nil {
				return err
			}
		}
	}
	if s.Wake != nil && len(records) > 0 {
		s.Wake(s.Now())
	}
	return nil
}

func (s *Service) refresh(ctx context.Context, access Access, previous *store.WorkspaceDigestRecord) (store.WorkspaceDigestRecord, error) {
	source, err := s.sources.Collect(ctx, access)
	if err != nil {
		return store.WorkspaceDigestRecord{}, err
	}
	source.UserID, source.Role = access.UserID, access.Role
	now := s.Now()
	record := Compile(source, previous, now)
	contentChanged := previous == nil || previous.ContentRev != record.ContentRev
	// An archived project is not summarized.
	summarize := contentChanged && record.Digest.Dirty && !record.Digest.Archived
	if summarize {
		record.SummaryDueAt = formatTime(s.nextDue(record, now))
	} else if contentChanged {
		record.SummaryDueAt = ""
	}
	if previous != nil && !contentChanged && previous.Digest.SourceRev == record.Digest.SourceRev &&
		previous.FilesRev == record.FilesRev && previous.Digest.CompiledAt == record.Digest.CompiledAt {
		return record, nil
	}
	if err := s.store.SaveWorkspaceDigest(ctx, record); err != nil {
		return store.WorkspaceDigestRecord{}, err
	}
	if summarize && s.Wake != nil {
		due, _ := parseTime(record.SummaryDueAt)
		s.Wake(due)
	}
	return record, nil
}

// nextDue is when a dirty digest's summary is due: at once for one never
// summarized, else once its changes settled (DigestDebounce) and at most
// every DigestMinInterval.
func (s *Service) nextDue(record store.WorkspaceDigestRecord, now time.Time) time.Time {
	summarized, ok := parseTime(record.Digest.SummarizedAt)
	if !ok {
		return now
	}
	due := now.Add(personalagent.DigestDebounce)
	if earliest := summarized.Add(personalagent.DigestMinInterval); earliest.After(due) {
		due = earliest
	}
	return due
}

// IntroWanted reports whether a workspace's intro predates its instruction
// files, and which files to read: the caller reads them from its device
// and calls SetIntro.
func (s *Service) IntroWanted(ctx context.Context, workspaceID string) (filesRev string, wanted bool, err error) {
	records, err := s.store.ListWorkspaceDigestsOf(ctx, workspaceID)
	if err != nil {
		return "", false, err
	}
	for _, record := range records {
		if record.NeedsIntro() {
			return record.FilesRev, true, nil
		}
	}
	return "", false, nil
}

// SetIntro records the intro read from the workspace's instruction files
// (content, the first one there is) as they were at filesRev.
func (s *Service) SetIntro(ctx context.Context, workspaceID, filesRev, content string) error {
	return s.store.SaveWorkspaceDigestIntro(ctx, workspaceID, filesRev, FirstParagraph(content))
}

// Due lists the digests whose summary is due within ahead, most recently
// active first.
func (s *Service) Due(ctx context.Context, ahead time.Duration, limit int) ([]store.WorkspaceDigestRecord, error) {
	return s.store.DueWorkspaceDigests(ctx, formatTime(s.Now().Add(ahead)), limit)
}

// Postpone makes a due summary due again at until (the person's limit was
// reached, or their assistant's device is away).
func (s *Service) Postpone(ctx context.Context, record store.WorkspaceDigestRecord, until time.Time) error {
	if err := s.store.ScheduleWorkspaceDigestSummary(ctx, record.Digest.UserID, record.Digest.WorkspaceID, formatTime(until)); err != nil {
		return err
	}
	if s.Wake != nil {
		s.Wake(until)
	}
	return nil
}

// Claim records sessionID as the summary session of record; false when
// another runs.
func (s *Service) Claim(ctx context.Context, record store.WorkspaceDigestRecord, sessionID string) (bool, error) {
	return s.store.ClaimWorkspaceDigestSummary(ctx, record.Digest.UserID, record.Digest.WorkspaceID, sessionID, record.ContentRev)
}

// SummariesSince counts the person's summary sessions since then.
func (s *Service) SummariesSince(ctx context.Context, userID string, since time.Time) (int, error) {
	return s.store.CountDigestSessionsSince(ctx, userID, formatTime(since))
}

// ErrNotSummarySession: the session summarizes no digest.
var ErrNotSummarySession = errors.New("not a digest summary session")

// Complete takes a summary session's end. completed with a valid answer
// (ParseSummary) replaces the summary; anything else keeps the previous
// one and tries again after DigestMinInterval. It returns the digest's
// workspace and why the answer was refused, if it was.
func (s *Service) Complete(ctx context.Context, sessionID string, completed bool, response string) (record store.WorkspaceDigestRecord, refused error, err error) {
	record, err = s.store.WorkspaceDigestForSummarySession(ctx, sessionID)
	if errors.Is(err, store.ErrNotFound) {
		return store.WorkspaceDigestRecord{}, nil, ErrNotSummarySession
	}
	if err != nil {
		return store.WorkspaceDigestRecord{}, nil, err
	}
	now := s.Now()
	retry := formatTime(now.Add(personalagent.DigestMinInterval))
	var summary *store.WorkspaceDigestSummary
	if completed {
		parsed, parseErr := ParseSummary(response)
		if parseErr == nil {
			summary = &parsed
		} else {
			refused = parseErr
		}
	} else {
		refused = errors.New("the summary session did not complete")
	}
	if err := s.store.FinishWorkspaceDigestSummary(ctx, record.Digest.UserID, record.Digest.WorkspaceID, sessionID, summary, record.PendingRev, formatTime(now), retry); err != nil {
		return record, refused, err
	}
	if s.Wake != nil {
		s.Wake(now.Add(personalagent.DigestMinInterval))
	}
	return record, refused, nil
}

func digestsOf(records []store.WorkspaceDigestRecord) []store.WorkspaceDigest {
	digests := make([]store.WorkspaceDigest, len(records))
	for i, record := range records {
		digests[i] = record.Digest
	}
	return digests
}

func find(records []store.WorkspaceDigestRecord, workspaceID string) *store.WorkspaceDigestRecord {
	for i := range records {
		if records[i].Digest.WorkspaceID == workspaceID {
			return &records[i]
		}
	}
	return nil
}
