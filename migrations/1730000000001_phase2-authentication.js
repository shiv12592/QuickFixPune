exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE otp_challenges
      ALTER COLUMN otp_hash DROP NOT NULL,
      ADD COLUMN role text NOT NULL DEFAULT 'CUSTOMER'
        CHECK (role IN ('CUSTOMER', 'PROVIDER')),
      ADD COLUMN provider text NOT NULL DEFAULT 'development'
        CHECK (provider IN ('development', 'msg91', 'fast2sms')),
      ADD COLUMN provider_request_id text,
      ADD COLUMN request_ip_hash text;

    ALTER TABLE auth_sessions
      ADD COLUMN role text NOT NULL DEFAULT 'CUSTOMER'
        CHECK (role IN ('CUSTOMER', 'PROVIDER'));

    ALTER TABLE auth_sessions ALTER COLUMN role DROP DEFAULT;
    ALTER TABLE otp_challenges ALTER COLUMN role DROP DEFAULT;
    ALTER TABLE otp_challenges ALTER COLUMN provider DROP DEFAULT;

    CREATE UNIQUE INDEX otp_challenges_one_active_idx
      ON otp_challenges (mobile_e164, role)
      WHERE consumed_at IS NULL;
    CREATE INDEX otp_challenges_ip_created_idx
      ON otp_challenges (request_ip_hash, created_at DESC)
      WHERE request_ip_hash IS NOT NULL;
  `);
};

exports.down = pgm => {
  pgm.sql(`
    DROP INDEX IF EXISTS otp_challenges_ip_created_idx;
    DROP INDEX IF EXISTS otp_challenges_one_active_idx;
    ALTER TABLE auth_sessions DROP COLUMN role;
    ALTER TABLE otp_challenges
      DROP COLUMN request_ip_hash,
      DROP COLUMN provider_request_id,
      DROP COLUMN provider,
      DROP COLUMN role,
      ALTER COLUMN otp_hash SET NOT NULL;
  `);
};
