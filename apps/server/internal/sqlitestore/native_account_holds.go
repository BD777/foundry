package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
	"strings"
	"time"
)

func (s *Store) setupNativeAccountHolds(ctx context.Context) error {
	// Holds belong to the device login, not the session that reported them.
	// Deleting that session's workspace must not re-enable a suspended login.
	// Dispatch bindings, in contrast, are deleted with their owning session.
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS native_account_holds (device_id TEXT NOT NULL, runtime TEXT NOT NULL, account_label TEXT NOT NULL, hold_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, resumed_at TEXT NOT NULL DEFAULT '', PRIMARY KEY(device_id,runtime,account_label))`,
		`CREATE TABLE IF NOT EXISTS native_account_dispatches (session_id TEXT NOT NULL,input_id TEXT NOT NULL,device_id TEXT NOT NULL,runtime TEXT NOT NULL,account_label TEXT NOT NULL,reported INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session_id,input_id))`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) nativeAccountHold(ctx context.Context, device, runtime, account string) (*store.NativeAccountHold, error) {
	if account == "" {
		return nil, nil
	}
	var raw string
	err := s.conn().QueryRowContext(ctx, `SELECT hold_json FROM native_account_holds WHERE device_id=? AND runtime=? AND account_label=? AND active=1`, device, runtime, account).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var hold store.NativeAccountHold
	err = json.Unmarshal([]byte(raw), &hold)
	return &hold, err
}

func (s *Store) nativeAccountProfile(ctx context.Context, device, profile string) (store.AgentProfileProjection, error) {
	return getJSON[store.AgentProfileProjection](ctx, s.conn(), `SELECT payload_json FROM agent_profiles WHERE device_id=? AND id=?`, device, profile)
}

func (s *Store) BindNativeAccount(ctx context.Context, session store.AgentSession) error {
	profile, err := s.nativeAccountProfile(ctx, session.DeviceID, session.ProfileID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if profile.ConnectionType != "local_login" || profile.Origin == "server" {
		return nil
	}
	account := strings.TrimSpace(profile.AccountLabel)
	if account == "" {
		return nil
	} // Never attach a suspension to an unknown account.
	var previous string
	err = s.conn().QueryRowContext(ctx, `SELECT account_label FROM native_account_dispatches WHERE session_id=? AND input_id=?`, session.ID, session.Input.ID).Scan(&previous)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil && previous != account {
		return fmt.Errorf("The official account changed after this input was dispatched. Send a new input to use the new account.")
	}
	hold, err := s.nativeAccountHold(ctx, session.DeviceID, session.Provider, account)
	if err != nil {
		return err
	}
	if hold != nil {
		return fmt.Errorf("This official account is suspended in Foundry (%s). Resume it in the device's account settings after resolving the suspension.", hold.Code)
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO native_account_dispatches(session_id,input_id,device_id,runtime,account_label) VALUES(?,?,?,?,?) ON CONFLICT(session_id,input_id) DO NOTHING`, session.ID, session.Input.ID, session.DeviceID, session.Provider, account)
	return err
}

// The first explicit signal per input wins. A duplicate or late event from
// that input cannot re-block an account after the person resumed it.
func (s *Store) ObserveNativeAccountHold(ctx context.Context, sessionID, inputID, code string) error {
	if code != "account_on_hold" {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var device, runtime, account string
	var reported int
	err = tx.QueryRowContext(ctx, `SELECT device_id,runtime,account_label,reported FROM native_account_dispatches WHERE session_id=? AND input_id=?`, sessionID, inputID).Scan(&device, &runtime, &account, &reported)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if reported != 0 {
		return nil
	}
	hold := store.NativeAccountHold{ID: uuid.NewString(), Code: code, ObservedAt: formatTime(time.Now()), AccountLabel: account}
	raw, err := json.Marshal(hold)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO native_account_holds(device_id,runtime,account_label,hold_json,active) VALUES(?,?,?,?,1) ON CONFLICT(device_id,runtime,account_label) DO UPDATE SET hold_json=excluded.hold_json,active=1,resumed_at=''`, device, runtime, account, string(raw)); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE native_account_dispatches SET reported=1 WHERE session_id=? AND input_id=?`, sessionID, inputID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ResumeNativeAccount(ctx context.Context, device, profileID, holdID string) error {
	profile, err := s.nativeAccountProfile(ctx, device, profileID)
	if err != nil {
		return err
	}
	if profile.ConnectionType != "local_login" || profile.Origin == "server" {
		return store.ErrNotFound
	}
	result, err := s.conn().ExecContext(ctx, `UPDATE native_account_holds SET active=0,resumed_at=? WHERE device_id=? AND runtime=? AND account_label=? AND active=1 AND json_extract(hold_json,'$.id')=?`, formatTime(time.Now()), device, profile.Runtime, strings.TrimSpace(profile.AccountLabel), holdID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) overlayNativeAccountProfiles(ctx context.Context, profiles []store.AgentProfileProjection, err error) ([]store.AgentProfileProjection, error) {
	if err != nil {
		return nil, err
	}
	rows, err := s.conn().QueryContext(ctx, `SELECT device_id,runtime,account_label,hold_json FROM native_account_holds WHERE active=1`)
	if err != nil {
		return nil, err
	}
	holds := map[string]*store.NativeAccountHold{}
	for rows.Next() {
		var device, runtime, account, raw string
		if err = rows.Scan(&device, &runtime, &account, &raw); err != nil {
			rows.Close()
			return nil, err
		}
		var hold store.NativeAccountHold
		if err = json.Unmarshal([]byte(raw), &hold); err != nil {
			rows.Close()
			return nil, err
		}
		holds[device+"\x00"+runtime+"\x00"+account] = &hold
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range profiles {
		p := &profiles[i]
		p.AccountHold = nil
		if p.ConnectionType != "local_login" || p.Origin == "server" {
			continue
		}
		p.AccountHold = holds[p.DeviceID+"\x00"+p.Runtime+"\x00"+strings.TrimSpace(p.AccountLabel)]
		if p.AccountHold != nil {
			p.Status = "unavailable"
			p.StatusDetail = "This official account is suspended. Resume it in the device's account settings after resolving the suspension."
		}
	}
	return profiles, nil
}

func (s *Store) overlayNativeAccountAgents(ctx context.Context, agents []store.AgentProjection, err error) ([]store.AgentProjection, error) {
	if err != nil {
		return nil, err
	}
	profiles, err := s.ListAgentProfiles(ctx, "")
	if err != nil {
		return nil, err
	}
	for i := range agents {
		a := &agents[i]
		a.AccountHold = nil
		for _, p := range profiles {
			if p.DeviceID == a.DeviceID && p.ID == a.ProfileID && p.Runtime == a.Provider && p.AccountHold != nil {
				a.AccountHold = p.AccountHold
				a.Status = "unavailable"
				a.StatusDetail = p.StatusDetail
				break
			}
		}
	}
	return agents, nil
}
