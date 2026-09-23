package sqlitestore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

func evidenceID(prefix string) string { return prefix + "_" + uuid.NewString() }
func evidenceNow() string             { return time.Now().UTC().Format(time.RFC3339Nano) }
func evidenceDigest(value any) string {
	// Normalize structs to sorted map keys; identity does not depend on struct field order.
	raw, _ := json.Marshal(value)
	var normalized any
	_ = json.Unmarshal(raw, &normalized)
	raw = []byte(canonicalEvidenceJSON(normalized))
	digest := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func canonicalEvidenceJSON(value any) string {
	switch v := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			parts = append(parts, canonicalEvidenceJSON(key)+":"+canonicalEvidenceJSON(v[key]))
		}
		return "{" + strings.Join(parts, ",") + "}"
	case []any:
		parts := make([]string, len(v))
		for i, item := range v {
			parts[i] = canonicalEvidenceJSON(item)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case float64:
		if v == 0 {
			return "0"
		}
		if math.Abs(v) >= 1e-6 && math.Abs(v) < 1e21 {
			return strconv.FormatFloat(v, 'f', -1, 64)
		}
		number := strconv.FormatFloat(v, 'e', -1, 64)
		parts := strings.Split(number, "e")
		exponent, _ := strconv.Atoi(parts[1])
		sign := ""
		if exponent >= 0 {
			sign = "+"
		}
		return parts[0] + "e" + sign + strconv.Itoa(exponent)
	default:
		var buffer bytes.Buffer
		encoder := json.NewEncoder(&buffer)
		encoder.SetEscapeHTML(false)
		_ = encoder.Encode(value)
		return strings.TrimSuffix(buffer.String(), "\n")
	}
}

func (s *Store) ListEvidenceRecords(ctx context.Context, issueID, kind string) ([]json.RawMessage, error) {
	issue, err := s.GetIssue(ctx, issueID)
	if err != nil {
		return nil, err
	}
	records, err := listJSON[json.RawMessage](ctx, s.conn(), `SELECT payload_json FROM evidence_records WHERE issue_id=? AND kind=? ORDER BY sequence DESC`, issue.ID, kind)
	if records == nil {
		records = []json.RawMessage{}
	}
	return records, err
}
func (s *Store) GetEvidenceRecord(ctx context.Context, issueID, kind, id string) (json.RawMessage, error) {
	issue, err := s.GetIssue(ctx, issueID)
	if err != nil {
		return nil, err
	}
	return getJSON[json.RawMessage](ctx, s.conn(), `SELECT payload_json FROM evidence_records WHERE issue_id=? AND workspace_id=? AND kind=? AND id=?`, issue.ID, issue.WorkspaceID, kind, id)
}
func (s *Store) nextEvidenceSequence(ctx context.Context, issueID, kind string) (int, error) {
	var sequence int
	err := s.conn().QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence),0)+1 FROM evidence_records WHERE issue_id=? AND kind=?`, issueID, kind).Scan(&sequence)
	return sequence, err
}
func (s *Store) insertEvidenceRecord(ctx context.Context, issue store.Issue, kind, id string, sequence int, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO evidence_records(id, workspace_id, issue_id, kind, sequence, payload_json) VALUES(?,?,?,?,?,?)`, id, issue.WorkspaceID, issue.ID, kind, sequence, string(raw))
	return err
}
func (s *Store) updateEvidenceProjection(ctx context.Context, id string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `UPDATE evidence_records SET payload_json=? WHERE id=?`, string(raw), id)
	return err
}
func (s *Store) auditEvidence(ctx context.Context, issue store.Issue, actor store.ActorRef, requestID, action, kind, id, digest, reason string) error {
	sequence, err := s.nextEvidenceSequence(ctx, issue.ID, "audit")
	if err != nil {
		return err
	}
	event := store.AuditEvent{SchemaVersion: 1, ID: evidenceID("aud"), WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, CreatedAt: evidenceNow(), CreatedBy: actor, Sequence: sequence, Action: action, Subject: store.AuditEventSubject{Type: kind, ID: id}, RequestID: requestID}
	if digest != "" {
		event.AfterDigest = &digest
	}
	if reason != "" {
		event.Reason = &reason
	}
	return s.insertEvidenceRecord(ctx, issue, "audit", event.ID, sequence, event)
}
func (s *Store) evidenceRequest(ctx context.Context, scope, requestID string, input any, action func(*Store) (any, error), result any) error {
	if strings.TrimSpace(requestID) == "" || len(requestID) > 200 {
		return fmt.Errorf("idempotency_key_required")
	}
	digest := evidenceDigest(input)
	return s.withTx(ctx, func(tx *Store) error {
		var previousDigest, response string
		err := tx.conn().QueryRowContext(ctx, `SELECT request_digest,response_json FROM evidence_requests WHERE scope=? AND request_id=?`, scope, requestID).Scan(&previousDigest, &response)
		if err == nil {
			if previousDigest != digest {
				return fmt.Errorf("idempotency_conflict: same key with different content")
			}
			return json.Unmarshal([]byte(response), result)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		value, err := action(tx)
		if err != nil {
			return err
		}
		raw, err := json.Marshal(value)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO evidence_requests VALUES(?,?,?,?)`, scope, requestID, digest, string(raw))
		if err != nil {
			return err
		}
		return json.Unmarshal(raw, result)
	})
}
