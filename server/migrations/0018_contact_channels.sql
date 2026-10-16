-- A contact's other phone numbers and e-mail addresses as their own fields (core/contacts).
--
-- Until now the front end kept them as tags written "tel:<number>" and "mail:<address>". They become two columns, and
-- the values already kept as tags move into them, in the order they were entered; those tags are then removed, so a
-- number is never kept twice. Other tags ("vip", "emergency:<id>" and so on) stay as they are.
-- Additive: two new columns with empty defaults; no column, table or row is dropped.

ALTER TABLE contacts
  ADD COLUMN other_phones text[] NOT NULL DEFAULT '{}' CHECK (cardinality(other_phones) <= 20),
  ADD COLUMN other_emails text[] NOT NULL DEFAULT '{}' CHECK (cardinality(other_emails) <= 20);

UPDATE contacts c SET
  other_phones = ARRAY(
    SELECT btrim(substr(x.t, 5)) FROM unnest(c.tags) WITH ORDINALITY AS x(t, n)
    WHERE x.t LIKE 'tel:%' AND btrim(substr(x.t, 5)) <> '' ORDER BY x.n),
  other_emails = ARRAY(
    SELECT btrim(substr(x.t, 6)) FROM unnest(c.tags) WITH ORDINALITY AS x(t, n)
    WHERE x.t LIKE 'mail:%' AND btrim(substr(x.t, 6)) <> '' ORDER BY x.n),
  tags = ARRAY(
    SELECT x.t FROM unnest(c.tags) WITH ORDINALITY AS x(t, n)
    WHERE x.t NOT LIKE 'tel:%' AND x.t NOT LIKE 'mail:%' ORDER BY x.n)
WHERE EXISTS (SELECT 1 FROM unnest(c.tags) AS y(t) WHERE y.t LIKE 'tel:%' OR y.t LIKE 'mail:%');

