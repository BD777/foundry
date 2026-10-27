package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// This file alone writes native_archive_targets. Generation fences prevent an
// old reply, sent before an offline archive/unarchive, from changing new intent.
func (s *Store) saveNativeArchiveTarget(ctx context.Context, ws string, v store.NativeArchiveTarget) error {
	if v.Provider != "claude" && v.Provider != "codex" {
		return nil
	}
	var priorRaw string
	var generation int64
	err := s.conn().QueryRowContext(ctx, `SELECT payload_json,generation FROM native_archive_targets WHERE provider=? AND native_id=? AND device_id=?`, v.Provider, v.NativeSessionID, v.DeviceID).Scan(&priorRaw, &generation)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil {
		var prior store.NativeArchiveTarget
		if err = json.Unmarshal([]byte(priorRaw), &prior); err != nil {
			return err
		}
		if prior.Desired == v.Desired {
			return nil
		}
	}
	v.Generation = generation + 1
	v.State = "pending"
	v.Error = ""
	v.AttemptedAt = ""
	v.AppliedAt = ""
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO native_archive_targets(provider,native_id,device_id,session_id,workspace_id,payload_json,generation) VALUES(?,?,?,?,?,?,?) ON CONFLICT(provider,native_id,device_id) DO UPDATE SET session_id=excluded.session_id,workspace_id=excluded.workspace_id,payload_json=excluded.payload_json,generation=excluded.generation`, v.Provider, v.NativeSessionID, v.DeviceID, v.SessionID, ws, string(raw), v.Generation)
	return err
}
func (s *Store) archiveNativeSubject(ctx context.Context, ws string, v archiveSubject, restore bool) error {
	desired := "archived"
	if restore {
		desired = "active"
	}
	workspace, err := s.GetWorkspace(ctx, ws)
	if err != nil {
		return err
	}
	targets := []store.NativeArchiveTarget{}
	if v.session != nil {
		err = scanRows(ctx, s.conn(), `SELECT provider,native_id,device_id FROM agent_session_native_ids WHERE session_id=?`, func(rows *sql.Rows) error {
			var t store.NativeArchiveTarget
			if e := rows.Scan(&t.Provider, &t.NativeSessionID, &t.DeviceID); e != nil {
				return e
			}
			t.SessionID = v.session.ID
			if t.Provider == v.session.Provider && t.DeviceID == v.session.DeviceID {
				t.ProfileID = v.session.ProfileID
			}
			targets = append(targets, t)
			return nil
		}, v.session.ID)
		if err != nil {
			return err
		}
		if len(targets) == 0 && v.session.NativeSessionID != "" {
			targets = append(targets, store.NativeArchiveTarget{Provider: v.session.Provider, NativeSessionID: v.session.NativeSessionID, DeviceID: v.session.DeviceID, SessionID: v.session.ID, ProfileID: v.session.ProfileID})
		}
	}
	if v.chat != nil && v.chat.NativeSessionID != "" {
		targets = append(targets, store.NativeArchiveTarget{Provider: v.chat.Provider, NativeSessionID: v.chat.NativeSessionID, DeviceID: workspace.DeviceID, ProfileID: v.chat.ProfileID})
	}
	for _, t := range targets {
		t.WorkspacePath = workspace.LocalPath
		t.Desired = desired
		if err = s.saveNativeArchiveTarget(ctx, ws, t); err != nil {
			return err
		}
	}
	return nil
}
func (s *Store) NativeArchiveTargets(ctx context.Context, device string) ([]store.NativeArchiveTarget, error) {
	return listJSON[store.NativeArchiveTarget](ctx, s.conn(), `SELECT payload_json FROM native_archive_targets WHERE device_id=? ORDER BY provider,native_id`, device)
}
func (s *Store) RecordNativeArchiveResult(ctx context.Context, v store.NativeArchiveTarget) error {
	return s.withTx(ctx, func(tx *Store) error {
		var raw string
		err := tx.conn().QueryRowContext(ctx, `SELECT payload_json FROM native_archive_targets WHERE provider=? AND native_id=? AND device_id=? AND generation=?`, v.Provider, v.NativeSessionID, v.DeviceID, v.Generation).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		var target store.NativeArchiveTarget
		if err = json.Unmarshal([]byte(raw), &target); err != nil {
			return err
		}
		switch v.State {
		case "pending", "failed", "unsupported", "not_found":
		case "active", "archived":
			if v.State != target.Desired {
				return nil
			}
		default:
			return nil
		}
		if v.NativeDescendantIDs != nil {
			target.NativeDescendantIDs = v.NativeDescendantIDs
		}
		target.State = v.State
		target.Error = v.Error
		target.AttemptedAt = formatTime(time.Now().UTC())
		if target.State == target.Desired {
			target.AppliedAt = target.AttemptedAt
		}
		data, err := json.Marshal(target)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `UPDATE native_archive_targets SET payload_json=? WHERE provider=? AND native_id=? AND device_id=? AND generation=?`, string(data), v.Provider, v.NativeSessionID, v.DeviceID, v.Generation)
		return err
	})
}
func (s *Store) RetryNativeArchive(ctx context.Context, ws, id string) error {
	return s.withTx(ctx, func(tx *Store) error {
		subject, err := tx.archiveSubject(ctx, ws, id)
		if err != nil {
			return err
		}
		a, err := tx.archiveInfo(ctx, ws, id, "", "")
		if err != nil {
			return err
		}
		if err = tx.archiveNativeSubject(ctx, ws, subject, a.ArchivedAt == ""); err != nil {
			return err
		}
		targets, err := tx.archiveInfo(ctx, ws, id, "", "")
		if err != nil {
			return err
		}
		if subject.chat != nil {
			targets, err = tx.archiveInfo(ctx, ws, id, subject.chat.Provider, subject.chat.NativeSessionID)
			if err != nil {
				return err
			}
		}
		for _, v := range targets.NativeArchive {
			v.State = "pending"
			v.Error = ""
			v.Generation++
			data, e := json.Marshal(v)
			if e != nil {
				return e
			}
			if _, e = tx.conn().ExecContext(ctx, `UPDATE native_archive_targets SET generation=?,payload_json=? WHERE provider=? AND native_id=? AND device_id=?`, v.Generation, string(data), v.Provider, v.NativeSessionID, v.DeviceID); e != nil {
				return e
			}
		}
		return nil
	})
}

// Preview uses the exact native ownership ledger without persisting intent.
func (s *Store) NativeArchivePreview(ctx context.Context, ws string, ids []string) ([]store.NativeArchiveTarget, error) {
	result := []store.NativeArchiveTarget{}
	workspace, err := s.GetWorkspace(ctx, ws)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		v, err := s.archiveSubject(ctx, ws, id)
		if errors.Is(err, store.ErrNotFound) || errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if v.session != nil {
			err = scanRows(ctx, s.conn(), `SELECT provider,native_id,device_id FROM agent_session_native_ids WHERE session_id=?`, func(rows *sql.Rows) error {
				t := store.NativeArchiveTarget{SessionID: id, Desired: "archived", WorkspacePath: workspace.LocalPath}
				if e := rows.Scan(&t.Provider, &t.NativeSessionID, &t.DeviceID); e != nil {
					return e
				}
				if t.Provider == v.session.Provider && t.DeviceID == v.session.DeviceID {
					t.ProfileID = v.session.ProfileID
				}
				result = append(result, t)
				return nil
			}, id)
			if err != nil {
				return nil, err
			}
		}
		if v.chat != nil && v.chat.NativeSessionID != "" {
			result = append(result, store.NativeArchiveTarget{Provider: v.chat.Provider, NativeSessionID: v.chat.NativeSessionID, DeviceID: workspace.DeviceID, ProfileID: v.chat.ProfileID, Desired: "archived", WorkspacePath: workspace.LocalPath})
		}
	}
	return result, nil
}

// An owned conversation keeps Foundry visibility when archived in the native
// app. Record the observed copy for its banner, without requesting an automatic
// unarchive; the next explicit Foundry turn restores it through the resume guard.
func (s *Store) observeOwnedNativeArchive(ctx context.Context, v store.ChatThread) {
	s.logNativeArchiveObservation(v, s.recordOwnedNativeArchiveObservation(ctx, v))
}

func (s *Store) observeNativeChatArchive(ctx context.Context, v store.ChatThread) {
	s.logNativeArchiveObservation(v, s.recordNativeChatArchiveObservation(ctx, v))
}

// Archive observations are best effort: a hidden/deleted owner is normal, and
// corrupt archive metadata must not roll back a device's unrelated inventory.
func (s *Store) logNativeArchiveObservation(v store.ChatThread, err error) {
	if err != nil && !errors.Is(err, store.ErrNotFound) && !errors.Is(err, sql.ErrNoRows) {
		log.Printf("native archive observation failed for %s/%s in workspace %s: %v", v.Provider, v.NativeSessionID, v.WorkspaceID, err)
	}
}

func (s *Store) recordOwnedNativeArchiveObservation(ctx context.Context, v store.ChatThread) error {
	owner, err := s.nativeSessionOwner(ctx, v.Provider, v.NativeSessionID)
	if err != nil || owner == "" {
		return err
	}
	var device string
	err = s.conn().QueryRowContext(ctx, `SELECT device_id FROM agent_session_native_ids WHERE provider=? AND native_id=?`, v.Provider, v.NativeSessionID).Scan(&device)
	if err != nil {
		return err
	}
	state := "active"
	if v.Archived {
		state = "archived"
	}
	var raw string
	err = s.conn().QueryRowContext(ctx, `SELECT payload_json FROM native_archive_targets WHERE provider=? AND native_id=? AND device_id=?`, v.Provider, v.NativeSessionID, device).Scan(&raw)
	if err == nil {
		var t store.NativeArchiveTarget
		if err = json.Unmarshal([]byte(raw), &t); err != nil {
			return err
		}
		// Device commands and their generation-fenced replies win over scans made
		// before the command. Once settled, native changes are observable again.
		if t.State == "pending" || t.State == "unsupported" || t.State == "failed" || t.State == state {
			return nil
		}
		t.State = state
		t.Error = ""
		data, e := json.Marshal(t)
		if e != nil {
			return e
		}
		_, err = s.conn().ExecContext(ctx, `UPDATE native_archive_targets SET payload_json=? WHERE provider=? AND native_id=? AND device_id=? AND generation=?`, string(data), v.Provider, v.NativeSessionID, device, t.Generation)
		return err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if !v.Archived {
		return nil
	}
	session, err := s.GetAgentSessionSummary(ctx, owner)
	if err != nil {
		return err
	}
	workspace, err := s.GetWorkspace(ctx, session.WorkspaceID)
	if err != nil {
		return err
	}
	desired := "active"
	if session.ArchivedAt != "" {
		desired = "archived"
	}
	t := store.NativeArchiveTarget{Provider: v.Provider, NativeSessionID: v.NativeSessionID, DeviceID: device, SessionID: owner, WorkspacePath: workspace.LocalPath, Desired: desired, Generation: 1, State: state, ProfileID: session.ProfileID}
	data, err := json.Marshal(t)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT OR IGNORE INTO native_archive_targets(provider,native_id,device_id,session_id,workspace_id,payload_json,generation) VALUES(?,?,?,?,?,?,?)`, t.Provider, t.NativeSessionID, t.DeviceID, owner, session.WorkspaceID, string(data), 1)
	return err
}
