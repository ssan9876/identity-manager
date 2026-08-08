-- The four well-known attribute keys `MailServerConnector` reads. Seeded
-- rather than hardcoded so an admin can see and edit them in the console like
-- any other definition.
--
-- `mail_aliases` is `string`, not a distinct list type: multi-value is carried
-- by `user_attributes`' own storage (every attribute reaches a connector as
-- `string[]`), not by the data type.
--
-- Hand-written rather than drizzle-generated — drizzle-kit diffs schema, not
-- data. ON CONFLICT DO NOTHING so re-running against a database that already
-- has these rows is a no-op, matching the idempotence every operator script
-- in this repo promises.
--
-- Deliberately seeds NO `connector_targets` row for 'mail_server': Postgres
-- forbids USING an enum value added by ALTER TYPE ... ADD VALUE within the
-- transaction that added it, and migration 0017 added it. That row is created
-- at runtime (or directly by a test).
INSERT INTO "attribute_definitions" ("key", "label", "data_type", "applies_to", "self_editable", "sort_order")
VALUES
  ('mail_enabled',    'Mail enabled',       'boolean', 'user', false, 100),
  ('mail_quota_mb',   'Mailbox quota (MB)', 'number',  'user', false, 101),
  ('mail_aliases',    'Mail aliases',       'string',  'user', false, 102),
  ('mail_admin_role', 'Mail admin role',    'string',  'user', false, 103)
ON CONFLICT ("key", "applies_to") DO NOTHING;
