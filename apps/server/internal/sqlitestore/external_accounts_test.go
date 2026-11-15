package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestExternalAccountAuditSurvivesAccountDeletionAfterMigration(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	app, err := db.CreateExternalProviderApp(ctx, store.ExternalProviderApp{
		ID: "xapp_audit", Provider: "acme-api", OwnerUserID: "user_1", Label: "Acme", CreatedVia: "extension",
	})
	if err != nil {
		t.Fatal(err)
	}
	account, err := db.SaveExternalAccount(ctx, store.ExternalAccount{
		ID: "xacc_audit", AppID: app.ID, Provider: app.Provider, OwnerUserID: "user_1",
		Label: app.Label, Mode: store.ExternalCredentialServerHeld, Status: store.ExternalAccountRevoked,
	})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := db.conn().ExecContext(ctx, `DROP TABLE external_account_events`); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE external_account_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			account_id TEXT NOT NULL REFERENCES external_accounts(id) ON DELETE CASCADE,
			kind TEXT NOT NULL,
			detail TEXT NOT NULL DEFAULT '',
			session_ref TEXT NOT NULL DEFAULT '',
			device_ref TEXT NOT NULL DEFAULT '',
			actor_id TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL
		)`,
		`INSERT INTO external_account_events
			(account_id, kind, detail, session_ref, device_ref, actor_id, created_at)
			VALUES ('xacc_audit', 'extension_instance_revoked', 'acme-api', '', '', 'user_1', '2026-11-13T00:00:00Z')`,
	} {
		if _, err := db.conn().ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.setupExternalAccounts(ctx); err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteExternalAccountAndProviderApp(ctx, account.ID, app.ID); err != nil {
		t.Fatal(err)
	}
	events, err := db.ListExternalAccountEvents(ctx, account.ID, 10)
	if err != nil || len(events) != 1 || events[0].Kind != "extension_instance_revoked" {
		t.Fatalf("audit after account deletion = %+v (%v)", events, err)
	}
	rows, err := db.conn().QueryContext(ctx, `PRAGMA foreign_key_list('external_account_events')`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("audit table still has a foreign key")
	}
}
