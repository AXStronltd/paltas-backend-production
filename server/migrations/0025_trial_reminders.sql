-- Approved platform release: new trials get 30 days, no extra grace, and a T-10 reminder.
-- Existing subscription terms and administrator-customised policies are never rewritten.
-- Release changes are explicitly attributed; administrator edits still require a real actor.
ALTER TABLE trial_policy_history ADD COLUMN change_source text NOT NULL DEFAULT 'administrator'
  CHECK (change_source IN ('administrator', 'release'));
ALTER TABLE trial_policy_history DROP CONSTRAINT trial_policy_history_check;
ALTER TABLE trial_policy_history ADD CONSTRAINT trial_policy_history_actor_check
  CHECK (changed_by IS NOT NULL OR version = 1 OR
    (change_source = 'release' AND reason LIKE 'Release 0025:%'));

WITH changed AS (
  UPDATE trial_policy SET version = version + 1, grace_days = 0,
    reminder_days = ARRAY[10,7,3,1], updated_at = now()
  WHERE id=1 AND version=1 AND updated_by IS NULL AND trial_days=30 AND grace_days=7
    AND reminder_days=ARRAY[7,3,1]
  RETURNING *
)
INSERT INTO trial_policy_history(version,policy,reason,change_source)
SELECT version, jsonb_build_object('trialDays',trial_days,'graceDays',grace_days,
  'reminderDays',to_jsonb(reminder_days),'verifyWithinDays',verify_within_days,
  'verifyLinkHours',verify_link_hours,'repeatWindowDays',repeat_window_days,
  'repeatMatch',to_jsonb(repeat_match),'secondProduct',second_product,'atExpiry',at_expiry,
  'keepRecords',keep_records,'exportAllowed',export_allowed,
  'suspendUnverifiedRequiresDelivery',suspend_unverified_requires_delivery),
  'Release 0025: 10-day reminder and read-only after the 30-day trial; existing terms preserved', 'release'
FROM changed;

-- Leave organisation-specific templates and manually edited defaults untouched.
UPDATE notification_templates SET
  body=E'Hello {{name}},\n\nThank you for trying {{productName}} with PALTAS. Your free trial for {{orgName}} ends on {{trialEnds}}.\n\nChoose a plan now to keep your team working without a break:\n\n{{link}}\n\nYou can pay by bank transfer if you do not use a card. Your plan starts once PALTAS confirms the payment.\n\n{{expiryMessage}} Your records stay safe, and you can still view and export them.\n\nNeed help? Write to us at {{helpEmail}}.\n\nThe PALTAS team',
  updated_at=now()
WHERE id='tpl_default_trial_reminder_email' AND org_id IS NULL
  AND body=E'Hello {{name}},\n\nThank you for trying {{productName}} with PALTAS. Your free trial for {{orgName}} ends on {{trialEnds}}.\n\nTo keep working without a break, choose a plan here:\n\n{{link}}\n\nIf you need a little longer, your workspace keeps working for {{graceDays}} more day(s) after the trial. After that it becomes read-only: every record is kept safe and you can still export everything.\n\nNeed help? Write to us at {{helpEmail}}.\n\nThe PALTAS team';
