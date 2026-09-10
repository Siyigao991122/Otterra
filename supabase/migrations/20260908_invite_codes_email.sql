-- Tracks which email address an invite code was sent to (lib/sendInviteEmail.ts).
-- Additive/nullable — codes generated without an email (or before this column existed) keep working.
-- Run manually in the Supabase SQL editor.

ALTER TABLE public.invite_codes ADD COLUMN IF NOT EXISTS email text;
CREATE INDEX IF NOT EXISTS idx_invite_codes_email ON public.invite_codes (email);
