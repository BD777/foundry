package sqlitestore

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"regexp"
	"strings"
)

func (s *Store) setupServiceTunnels(ctx context.Context) error {
	_, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS service_tunnels (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, revision INTEGER NOT NULL, payload_json TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS service_tunnels_workspace ON service_tunnels(workspace_id);
 CREATE UNIQUE INDEX IF NOT EXISTS service_tunnels_host ON service_tunnels(json_extract(payload_json,'$.hostLabel')) WHERE json_extract(payload_json,'$.hostLabel') IS NOT NULL;`)
	if err != nil {
		return err
	}
	return s.backfillServiceHostLabels(ctx)
}
func (s *Store) ListServiceTunnels(ctx context.Context, workspaceID string) ([]store.ServiceTunnel, error) {
	return listJSON[store.ServiceTunnel](ctx, s.conn(), `SELECT payload_json FROM service_tunnels WHERE workspace_id=? ORDER BY id`, workspaceID)
}
func (s *Store) GetServiceTunnel(ctx context.Context, id string) (store.ServiceTunnel, error) {
	var raw string
	var item store.ServiceTunnel
	err := s.conn().QueryRowContext(ctx, `SELECT payload_json FROM service_tunnels WHERE id=?`, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return item, store.ErrNotFound
	}
	if err != nil {
		return item, err
	}
	err = json.Unmarshal([]byte(raw), &item)
	return item, err
}
func (s *Store) CreateServiceTunnel(ctx context.Context, item store.ServiceTunnel) error {
	raw, err := json.Marshal(item)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO service_tunnels(id,workspace_id,revision,payload_json) VALUES(?,?,?,?)`, item.ID, item.WorkspaceID, item.Revision, string(raw))
	return err
}
func (s *Store) UpdateServiceTunnel(ctx context.Context, item store.ServiceTunnel, expected int64) error {
	raw, err := json.Marshal(item)
	if err != nil {
		return err
	}
	result, err := s.conn().ExecContext(ctx, `UPDATE service_tunnels SET revision=?,payload_json=? WHERE id=? AND workspace_id=? AND revision=? AND COALESCE(json_extract(payload_json,'$.hostLabel'),'')=?`, item.Revision, string(raw), item.ID, item.WorkspaceID, expected, item.HostLabel)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return fmt.Errorf("service mapping changed; refresh before retrying")
	}
	return nil
}

func (s *Store) MarkServiceTunnelSeen(ctx context.Context, id string, at string) error {
	_, err := s.conn().ExecContext(ctx, `UPDATE service_tunnels SET payload_json=json_set(payload_json,'$.lastSeenAt',?) WHERE id=?`, at, id)
	return err
}

// DeleteServiceTunnel removes a mapping. Its random host label is never
// allocated again, so a retired application origin is not reassigned.
func (s *Store) DeleteServiceTunnel(ctx context.Context, id string, workspaceID string) error {
	result, err := s.conn().ExecContext(ctx, `DELETE FROM service_tunnels WHERE id=? AND workspace_id=?`, id, workspaceID)
	if err != nil {
		return err
	}
	if n, err := result.RowsAffected(); err != nil || n != 1 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) GetServiceTunnelByHostLabel(ctx context.Context, label string) (store.ServiceTunnel, error) {
	var raw string
	var item store.ServiceTunnel
	err := s.conn().QueryRowContext(ctx, `SELECT payload_json FROM service_tunnels WHERE json_extract(payload_json,'$.hostLabel')=?`, label).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return item, store.ErrNotFound
	}
	if err != nil {
		return item, err
	}
	err = json.Unmarshal([]byte(raw), &item)
	return item, err
}

// Old mappings predate hostname identity. Allocate once and persist it rather
// than deriving an origin from a mutable name or a retry key that can recur.
func (s *Store) backfillServiceHostLabels(ctx context.Context) error {
	items, err := listJSON[store.ServiceTunnel](ctx, s.conn(), `SELECT payload_json FROM service_tunnels WHERE COALESCE(json_extract(payload_json,'$.hostLabel'),'')=''`)
	if err != nil {
		return err
	}
	for _, item := range items {
		var nonce [16]byte
		if _, err = rand.Read(nonce[:]); err != nil {
			return err
		}
		slug := regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(strings.ToLower(item.Name), "-")
		slug = strings.Trim(slug, "-")
		if len(slug) > 20 {
			slug = strings.TrimRight(slug[:20], "-")
		}
		if slug == "" {
			slug = "service"
		}
		item.HostLabel = slug + "-" + hex.EncodeToString(nonce[:])
		raw, err := json.Marshal(item)
		if err != nil {
			return err
		}
		if _, err = s.conn().ExecContext(ctx, `UPDATE service_tunnels SET payload_json=? WHERE id=? AND COALESCE(json_extract(payload_json,'$.hostLabel'),'')=''`, string(raw), item.ID); err != nil {
			return err
		}
	}
	return nil
}
