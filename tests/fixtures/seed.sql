-- Slonview test fixture. Usage:
--   dropdb --if-exists slonview_fixture && createdb slonview_fixture && psql -v ON_ERROR_STOP=1 slonview_fixture -f tests/fixtures/seed.sql

CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');

CREATE TABLE customers (
  id bigserial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO customers (email, name, created_at)
SELECT 'user' || g || '@example.com', 'Customer ' || g, timestamptz '2024-01-01' + (g || ' minutes')::interval
FROM generate_series(1, 1000) g;

CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(id),
  status order_status NOT NULL,
  amount numeric(12,2) NOT NULL,
  note text,
  created_at timestamptz NOT NULL
);

INSERT INTO orders (customer_id, status, amount, note, created_at)
SELECT 1 + (g % 1000),
       (ARRAY['pending','paid','shipped','cancelled']::order_status[])[1 + (g % 4)],
       round(((g::bigint * 7919) % 100000) / 100.0, 2),
       CASE WHEN g % 10 = 0 THEN NULL ELSE 'note ' || g END,
       timestamptz '2024-01-01' + (g || ' seconds')::interval
FROM generate_series(1, 1000000) g;

CREATE INDEX orders_status_idx ON orders(status);
CREATE INDEX orders_created_at_idx ON orders(created_at);

CREATE TABLE all_types (
  id serial PRIMARY KEY,
  c_int integer,
  c_numeric numeric,
  c_text text,
  c_varchar varchar(20),
  c_bool boolean,
  c_uuid uuid,
  c_date date,
  c_ts timestamptz,
  c_interval interval,
  c_jsonb jsonb,
  c_int_arr int[],
  c_text_arr text[],
  c_bytea bytea,
  c_enum order_status,
  c_inet inet
);

INSERT INTO all_types (c_int, c_numeric, c_text, c_varchar, c_bool, c_uuid, c_date, c_ts, c_interval,
                       c_jsonb, c_int_arr, c_text_arr, c_bytea, c_enum, c_inet) VALUES
  (1, 3.14159, 'hello', 'short', true, '6f1c1f5e-1d2b-4c1a-9a51-0e1f2a3b4c5d', '2024-02-29', '2024-02-29 12:34:56+00', '1 day 2 hours',
   '{"a": 1, "nested": {"b": [1, 2, 3]}, "s": "x"}', '{1,2,3}', '{"a","b c","d\"e"}', '\xdeadbeef', 'paid', '192.168.1.1'),
  (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (-2147483648, -0.000001, 'NULL', '', false, '00000000-0000-0000-0000-000000000000', '1970-01-01', '1970-01-01 00:00:00+00', '-1 second',
   '[]', '{}', '{}', '\x', 'pending', '::1'),
  (42, 1e20, repeat('long text ', 1000), 'tab	and newline
here', true, gen_random_uuid(), '9999-12-31', 'infinity', '100 years',
   '{"emoji": "🐘", "quote": "it''s \"quoted\""}', '{NULL,5}', '{NULL,"x"}', decode(repeat('ab', 5000), 'hex'), 'shipped', '10.0.0.0/8'),
  (7, 0, 'O''Brien; DROP TABLE orders; --', 'unicode ñ 日本', NULL, gen_random_uuid(), now()::date, now(), '0', '"just a string"', '{7}', '{"single"}', '\x00ff', 'cancelled', '2001:db8::1');

CREATE SCHEMA "Sales Data";
CREATE TABLE "Sales Data"."Weird ""Name"" Table" (
  "Id" integer PRIMARY KEY,
  "Column With Space" text,
  "select" text,
  "ünïcödé" text
);
INSERT INTO "Sales Data"."Weird ""Name"" Table"
SELECT g, 'value ' || g, 'kw ' || g, 'ü' || g FROM generate_series(1, 250) g;

CREATE TABLE no_pk (a int, b text);
INSERT INTO no_pk SELECT g % 50, 'row ' || g FROM generate_series(1, 1200) g;

CREATE TABLE composite_pk (tenant int, item int, label text, PRIMARY KEY (tenant, item));
INSERT INTO composite_pk SELECT t, i, 't' || t || 'i' || i FROM generate_series(1, 30) t, generate_series(1, 40) i;

-- Foreign keys beyond orders.customer_id: one across a quoted schema (single column, so the
-- grid can follow it) and one on two columns (the grid must not offer to follow it).
CREATE TABLE fk_links (
  id integer PRIMARY KEY,
  weird_id integer REFERENCES "Sales Data"."Weird ""Name"" Table"("Id"),
  tenant int,
  item int,
  FOREIGN KEY (tenant, item) REFERENCES composite_pk (tenant, item)
);
INSERT INTO fk_links SELECT g, g, 1 + g % 30, 1 + g % 40 FROM generate_series(1, 20) g;

CREATE VIEW paid_orders AS SELECT id, customer_id, amount, created_at FROM orders WHERE status = 'paid';
CREATE MATERIALIZED VIEW order_totals AS SELECT customer_id, count(*) AS n, sum(amount) AS total FROM orders GROUP BY customer_id;

CREATE TABLE events (id bigint NOT NULL, happened_at date NOT NULL, payload jsonb, PRIMARY KEY (id, happened_at))
  PARTITION BY RANGE (happened_at);
CREATE TABLE events_2024 PARTITION OF events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE events_2025 PARTITION OF events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
INSERT INTO events SELECT g, date '2024-01-01' + (g % 700), jsonb_build_object('n', g) FROM generate_series(1, 5000) g;

CREATE TABLE scratch_insert_target (LIKE orders INCLUDING DEFAULTS);
ALTER TABLE scratch_insert_target ADD PRIMARY KEY (id);

-- Routines for the sidebar's Functions group: an overloaded SQL pair, plpgsql, a procedure,
-- a custom aggregate, and a function in a quoted schema.
CREATE OR REPLACE FUNCTION order_total(p_customer bigint) RETURNS numeric
  LANGUAGE sql STABLE AS $$ SELECT coalesce(sum(amount), 0) FROM orders WHERE customer_id = p_customer $$;
CREATE OR REPLACE FUNCTION order_total(p_customer bigint, p_status order_status) RETURNS numeric
  LANGUAGE sql STABLE AS $$ SELECT coalesce(sum(amount), 0) FROM orders WHERE customer_id = p_customer AND status = p_status $$;
CREATE OR REPLACE FUNCTION customer_label(p_id bigint) RETURNS text
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_name text;
BEGIN
  SELECT name INTO v_name FROM customers WHERE id = p_id;
  RETURN coalesce(v_name, 'unknown') || ' <#' || p_id || '>';
END;
$$;
CREATE OR REPLACE PROCEDURE archive_orders(p_before timestamptz, INOUT p_moved bigint DEFAULT 0)
  LANGUAGE plpgsql AS $$
BEGIN
  SELECT count(*) INTO p_moved FROM orders WHERE created_at < p_before;
END;
$$;
CREATE OR REPLACE FUNCTION text_concat_step(acc text, val text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN acc = '' THEN val ELSE acc || ', ' || val END $$;
CREATE OR REPLACE AGGREGATE comma_join(text) (SFUNC = text_concat_step, STYPE = text, INITCOND = '');
CREATE OR REPLACE FUNCTION "Sales Data"."Weird Total"("Region Code" text, include_tax boolean DEFAULT true)
  RETURNS TABLE("Region" text, total numeric)
  LANGUAGE sql STABLE AS $$ SELECT "Region Code", 0::numeric WHERE include_tax IS NOT NULL $$;

-- Objects for the sidebar's Sequences, Types, Triggers and Extensions groups. Written to be
-- re-runnable (IF NOT EXISTS / OR REPLACE / duplicate_object guards).
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq AS integer START WITH 1000 INCREMENT BY 10;
SELECT setval('invoice_number_seq', 1010);
CREATE SEQUENCE IF NOT EXISTS "Sales Data"."Ticket Seq";
DO $$ BEGIN
  CREATE DOMAIN positive_amount AS numeric(12,2) DEFAULT 0 NOT NULL
    CONSTRAINT positive_amount_check CHECK (VALUE >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
COMMENT ON DOMAIN positive_amount IS 'Money amount, never negative';
DO $$ BEGIN
  CREATE TYPE money_range AS (low numeric(12,2), high numeric(12,2), currency text COLLATE "C");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "Sales Data"."Region Kind" AS ENUM ('north', 'south''s', 'East West');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE OR REPLACE FUNCTION customers_email_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.email NOT LIKE '%@%' THEN
    RAISE EXCEPTION 'invalid email: %', NEW.email;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER customers_email_check BEFORE INSERT OR UPDATE OF email ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_email_check();
CREATE OR REPLACE FUNCTION forbid_truncate() RETURNS trigger
  LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TRUNCATE is not allowed on %', TG_TABLE_NAME; END; $$;
CREATE OR REPLACE TRIGGER orders_no_truncate BEFORE TRUNCATE ON orders
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
ALTER TABLE orders DISABLE TRIGGER orders_no_truncate;
-- AFTER row triggers whose function does nothing; the one on the partitioned table is cloned
-- onto each partition, and those clones must not show up in the tree.
CREATE OR REPLACE FUNCTION "Sales Data"."Weird Audit Fn"() RETURNS trigger
  LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;
CREATE OR REPLACE TRIGGER "Weird Audit" AFTER INSERT OR DELETE ON "Sales Data"."Weird ""Name"" Table"
  FOR EACH ROW EXECUTE FUNCTION "Sales Data"."Weird Audit Fn"();
CREATE OR REPLACE TRIGGER events_audit AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION "Sales Data"."Weird Audit Fn"();

ANALYZE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'slonview_ro') THEN
    CREATE ROLE slonview_ro LOGIN PASSWORD 'slonview_ro';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public, "Sales Data" TO slonview_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public, "Sales Data" TO slonview_ro;
