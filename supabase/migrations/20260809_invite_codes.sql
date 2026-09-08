-- Per-person invite codes for the closed-beta access gate (middleware.ts / lib/inviteCodes.ts).
-- Only ever touched via the service-role key (supabaseAdmin) — RLS enabled, no policies,
-- so anon/authenticated roles have zero access.
-- Run manually in the Supabase SQL editor (this repo has no linked Supabase CLI project).

CREATE TABLE IF NOT EXISTS public.invite_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text,
  max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON public.invite_codes (code);

ALTER TABLE public.invite_codes ENABLE ROW LEVEL SECURITY;
-- No policies added — only the service-role key (lib/supabaseAdmin) can read/write.

-- Atomically consumes one use of a code so two simultaneous redemptions can't
-- both succeed past max_uses (a plain select-then-update from the app has a race).
--
-- The output column is named invite_id, not id: RETURNS TABLE implicitly
-- declares a PL/pgSQL variable per output column, and naming it "id" collides
-- with invite_codes.id — every bare `id` reference below (including inside
-- the UPDATE ... WHERE) resolves to that variable instead of the column and
-- Postgres raises "column reference \"id\" is ambiguous".
DROP FUNCTION IF EXISTS public.redeem_invite_code(text);

CREATE OR REPLACE FUNCTION public.redeem_invite_code(p_code text)
RETURNS TABLE (result text, invite_id uuid)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row public.invite_codes%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.invite_codes WHERE code = p_code FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found', NULL::uuid;
    RETURN;
  END IF;

  IF v_row.revoked THEN
    RETURN QUERY SELECT 'revoked', v_row.id;
    RETURN;
  END IF;

  IF v_row.use_count >= v_row.max_uses THEN
    RETURN QUERY SELECT 'exhausted', v_row.id;
    RETURN;
  END IF;

  UPDATE public.invite_codes
  SET use_count = use_count + 1,
      redeemed_at = COALESCE(redeemed_at, now())
  WHERE public.invite_codes.id = v_row.id;

  RETURN QUERY SELECT 'ok', v_row.id;
END;
$$;
