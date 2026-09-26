exports.up = pgm => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS btree_gist;

    CREATE SEQUENCE customer_public_id_seq START WITH 1;
    CREATE SEQUENCE provider_public_id_seq START WITH 1;

    CREATE TABLE users (
      id uuid PRIMARY KEY,
      mobile_e164 text UNIQUE,
      full_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT users_mobile_e164_format
        CHECK (mobile_e164 IS NULL OR mobile_e164 ~ '^\\+[1-9][0-9]{7,14}$'),
      CONSTRAINT users_full_name_nonempty CHECK (length(btrim(full_name)) > 0)
    );

    CREATE TABLE customer_profiles (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      public_id text NOT NULL UNIQUE
        DEFAULT ('QF-CUST-' || lpad(nextval('customer_public_id_seq')::text, 6, '0')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT customer_public_id_format CHECK (public_id ~ '^QF-CUST-[0-9]{6,}$')
    );

    CREATE TABLE service_categories (
      id uuid PRIMARY KEY,
      name text NOT NULL UNIQUE,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT service_categories_name_nonempty CHECK (length(btrim(name)) > 0)
    );

    CREATE TABLE provider_profiles (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      public_id text NOT NULL UNIQUE
        DEFAULT ('QF-PROV-' || lpad(nextval('provider_public_id_seq')::text, 6, '0')),
      service_category_id uuid REFERENCES service_categories(id) ON DELETE SET NULL,
      service text NOT NULL,
      experience integer NOT NULL DEFAULT 0 CHECK (experience BETWEEN 0 AND 60),
      private_address text NOT NULL,
      area text NOT NULL,
      pincode text NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
      verification_status text NOT NULL DEFAULT 'PENDING'
        CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED')),
      availability text NOT NULL DEFAULT 'OFFLINE'
        CHECK (availability IN ('AVAILABLE', 'BUSY', 'OFFLINE')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT provider_service_nonempty CHECK (length(btrim(service)) > 0)
    );

    CREATE TABLE saved_locations (
      id uuid PRIMARY KEY,
      customer_id uuid NOT NULL REFERENCES customer_profiles(user_id) ON DELETE CASCADE,
      label text NOT NULL,
      address text NOT NULL,
      area text NOT NULL,
      pincode text NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
      latitude double precision,
      longitude double precision,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, customer_id),
      CONSTRAINT saved_locations_coordinates_pair CHECK (
        (latitude IS NULL AND longitude IS NULL) OR
        (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
      )
    );

    CREATE TABLE conversations (
      id uuid PRIMARY KEY,
      public_id text NOT NULL UNIQUE,
      reference text NOT NULL UNIQUE,
      customer_id uuid NOT NULL REFERENCES customer_profiles(user_id) ON DELETE RESTRICT,
      provider_id uuid NOT NULL REFERENCES provider_profiles(user_id) ON DELETE RESTRICT,
      service text NOT NULL,
      status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
      request_status text NOT NULL DEFAULT 'PENDING'
        CHECK (request_status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED')),
      request_description text NOT NULL DEFAULT '',
      preferred_visit_time text NOT NULL DEFAULT '',
      current_service_request_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT conversations_participant_key UNIQUE (id, customer_id, provider_id)
    );

    CREATE TABLE service_requests (
      id uuid PRIMARY KEY,
      public_id text NOT NULL UNIQUE,
      conversation_id uuid NOT NULL,
      customer_id uuid NOT NULL REFERENCES customer_profiles(user_id) ON DELETE RESTRICT,
      provider_id uuid NOT NULL REFERENCES provider_profiles(user_id) ON DELETE RESTRICT,
      service text NOT NULL,
      description text NOT NULL,
      preferred_visit_time text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT service_requests_conversation_participants_fk
        FOREIGN KEY (conversation_id, customer_id, provider_id)
        REFERENCES conversations(id, customer_id, provider_id) ON DELETE CASCADE,
      UNIQUE (id, customer_id, provider_id)
    );

    ALTER TABLE conversations
      ADD CONSTRAINT conversations_current_request_fk
      FOREIGN KEY (current_service_request_id)
      REFERENCES service_requests(id) ON DELETE SET NULL;

    CREATE TABLE bookings (
      id uuid PRIMARY KEY,
      public_id text NOT NULL UNIQUE,
      service_request_id uuid UNIQUE REFERENCES service_requests(id) ON DELETE SET NULL,
      customer_id uuid NOT NULL REFERENCES customer_profiles(user_id) ON DELETE RESTRICT,
      provider_id uuid NOT NULL REFERENCES provider_profiles(user_id) ON DELETE RESTRICT,
      saved_location_id uuid,
      starts_at timestamptz,
      ends_at timestamptz,
      expires_at timestamptz,
      status text NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'COMPLETED')),
      address_snapshot text,
      area_snapshot text,
      pincode_snapshot text,
      latitude_snapshot double precision,
      longitude_snapshot double precision,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT bookings_request_participants_fk
        FOREIGN KEY (service_request_id, customer_id, provider_id)
        REFERENCES service_requests(id, customer_id, provider_id),
      CONSTRAINT bookings_location_owner_fk
        FOREIGN KEY (saved_location_id, customer_id)
        REFERENCES saved_locations(id, customer_id),
      CONSTRAINT bookings_slot_pair CHECK (
        (starts_at IS NULL AND ends_at IS NULL) OR
        (starts_at IS NOT NULL AND ends_at > starts_at)
      ),
      CONSTRAINT bookings_coordinates_pair CHECK (
        (latitude_snapshot IS NULL AND longitude_snapshot IS NULL) OR
        (latitude_snapshot BETWEEN -90 AND 90 AND longitude_snapshot BETWEEN -180 AND 180)
      ),
      CONSTRAINT bookings_provider_no_overlap
        EXCLUDE USING gist (
          provider_id WITH =,
          tstzrange(starts_at, ends_at, '[)') WITH &&
        )
        WHERE (status IN ('PENDING', 'CONFIRMED') AND starts_at IS NOT NULL)
    );

    CREATE TABLE provider_weekly_hours (
      id uuid PRIMARY KEY,
      provider_id uuid NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
      weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      starts_at time NOT NULL,
      ends_at time NOT NULL CHECK (ends_at > starts_at),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider_id, weekday, starts_at, ends_at)
    );

    CREATE TABLE provider_time_off (
      id uuid PRIMARY KEY,
      provider_id uuid NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
      reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE booking_events (
      id uuid PRIMARY KEY,
      booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
      event_type text NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE messages (
      id uuid PRIMARY KEY,
      public_id text NOT NULL UNIQUE,
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      sender_type text NOT NULL CHECK (sender_type IN ('CUSTOMER', 'PROVIDER')),
      message text NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 1000),
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE FUNCTION quickfix_validate_message_sender() RETURNS trigger AS $$
    BEGIN
      IF NEW.sender_type = 'CUSTOMER' AND NOT EXISTS (
        SELECT 1 FROM conversations
        WHERE id = NEW.conversation_id AND customer_id = NEW.sender_id
      ) THEN
        RAISE EXCEPTION 'Customer sender must participate in the conversation'
          USING ERRCODE = '23514';
      ELSIF NEW.sender_type = 'PROVIDER' AND NOT EXISTS (
        SELECT 1 FROM conversations
        WHERE id = NEW.conversation_id AND provider_id = NEW.sender_id
      ) THEN
        RAISE EXCEPTION 'Provider sender must participate in the conversation'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER messages_sender_participant
      BEFORE INSERT OR UPDATE OF conversation_id, sender_id, sender_type ON messages
      FOR EACH ROW EXECUTE FUNCTION quickfix_validate_message_sender();

    CREATE TABLE otp_challenges (
      id uuid PRIMARY KEY,
      mobile_e164 text NOT NULL CHECK (mobile_e164 ~ '^\\+[1-9][0-9]{7,14}$'),
      otp_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE auth_sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE legacy_record_map (
      source_collection text NOT NULL,
      legacy_id text NOT NULL,
      target_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (source_collection, legacy_id)
    );

    CREATE INDEX provider_profiles_search_idx
      ON provider_profiles (verification_status, service, pincode, area);
    CREATE INDEX provider_profiles_availability_idx
      ON provider_profiles (availability);
    CREATE INDEX conversations_customer_updated_idx
      ON conversations (customer_id, updated_at DESC);
    CREATE INDEX conversations_provider_updated_idx
      ON conversations (provider_id, updated_at DESC);
    CREATE INDEX service_requests_customer_created_idx
      ON service_requests (customer_id, created_at DESC);
    CREATE INDEX service_requests_provider_status_idx
      ON service_requests (provider_id, status, created_at DESC);
    CREATE INDEX bookings_customer_start_idx
      ON bookings (customer_id, starts_at);
    CREATE INDEX bookings_provider_start_idx
      ON bookings (provider_id, starts_at);
    CREATE INDEX messages_conversation_created_idx
      ON messages (conversation_id, created_at, id);
    CREATE INDEX otp_challenges_mobile_created_idx
      ON otp_challenges (mobile_e164, created_at DESC);
    CREATE INDEX auth_sessions_user_expiry_idx
      ON auth_sessions (user_id, expires_at);
    CREATE INDEX provider_weekly_hours_lookup_idx
      ON provider_weekly_hours (provider_id, weekday, starts_at);
    CREATE INDEX provider_time_off_lookup_idx
      ON provider_time_off USING gist (provider_id, tstzrange(starts_at, ends_at, '[)'));

    CREATE FUNCTION quickfix_set_updated_at() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION quickfix_set_updated_at();
    CREATE TRIGGER customer_profiles_updated_at BEFORE UPDATE ON customer_profiles
      FOR EACH ROW EXECUTE FUNCTION quickfix_set_updated_at();
    CREATE TRIGGER provider_profiles_updated_at BEFORE UPDATE ON provider_profiles
      FOR EACH ROW EXECUTE FUNCTION quickfix_set_updated_at();
    CREATE TRIGGER service_categories_updated_at BEFORE UPDATE ON service_categories
      FOR EACH ROW EXECUTE FUNCTION quickfix_set_updated_at();
    CREATE TRIGGER saved_locations_updated_at BEFORE UPDATE ON saved_locations
      FOR EACH ROW EXECUTE FUNCTION quickfix_set_updated_at();
    CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations
      FOR EACH ROW EXECUTE FUNCTION quickfix_set_updated_at();
    CREATE TRIGGER service_requests_updated_at BEFORE UPDATE ON service_requests
      FOR EACH ROW EXECUTE FUNCTION quickfix_set_updated_at();
    CREATE TRIGGER bookings_updated_at BEFORE UPDATE ON bookings
      FOR EACH ROW EXECUTE FUNCTION quickfix_set_updated_at();
    CREATE TRIGGER provider_weekly_hours_updated_at BEFORE UPDATE ON provider_weekly_hours
      FOR EACH ROW EXECUTE FUNCTION quickfix_set_updated_at();
    CREATE TRIGGER provider_time_off_updated_at BEFORE UPDATE ON provider_time_off
      FOR EACH ROW EXECUTE FUNCTION quickfix_set_updated_at();
    CREATE TRIGGER otp_challenges_updated_at BEFORE UPDATE ON otp_challenges
      FOR EACH ROW EXECUTE FUNCTION quickfix_set_updated_at();
    CREATE TRIGGER auth_sessions_updated_at BEFORE UPDATE ON auth_sessions
      FOR EACH ROW EXECUTE FUNCTION quickfix_set_updated_at();
  `);
};

exports.down = pgm => {
  pgm.sql(`
    DROP TABLE IF EXISTS legacy_record_map, auth_sessions, otp_challenges,
      messages, booking_events, provider_time_off, provider_weekly_hours,
      bookings, service_requests, conversations, saved_locations,
      provider_profiles, service_categories, customer_profiles, users CASCADE;
    DROP FUNCTION IF EXISTS quickfix_set_updated_at() CASCADE;
    DROP FUNCTION IF EXISTS quickfix_validate_message_sender() CASCADE;
    DROP SEQUENCE IF EXISTS customer_public_id_seq, provider_public_id_seq;
  `);
};
