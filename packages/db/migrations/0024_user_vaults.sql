-- Key vault (2026-10-28): provider logins are sealed under a key only the reader
-- holds (packages/auth/src/vault.js, @profullstack/sealed-secrets).
--
-- One row per reader: KDF salt and parameters, the data key wrapped by their
-- passphrase and by a one-time recovery key, a key-check value. Nothing in it
-- opens without the passphrase or the recovery key.
--
-- Sealed columns keep their names; the prefix is the seal version:
--   v1.  the old PLAYLIST_SECRET key (held by the server 24/7) -- read only by the
--        one-shot migration when the owner unlocks
--   v2.  sealed under the owner's vault
-- Count what is left with legacySealedCounts() / GET /internal/vault/legacy.
create table if not exists user_vaults (
  user_id uuid primary key references users (id) on delete cascade,
  seal jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
