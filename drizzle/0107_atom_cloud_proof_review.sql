-- Scheduled server retrieval is an explicit alternative to a local shutdown test.
-- Keep legacy computer-off confirmations and the approved comparison receipt intact.
ALTER TABLE feedback_iseb_rollouts ADD COLUMN cloud_proof_review jsonb;
