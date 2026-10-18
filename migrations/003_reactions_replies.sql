-- ═══════════════════════════════════════════════════════════════
--  Blink — migration 003: emoji reactions, replies, 5-minute save window
--
--  For projects that already ran schema.sql (version 1) AND migration 002.
--  (Brand-new project? Just run schema.sql — it already includes all of this.)
--  Paste into Supabase → SQL Editor → New query → Run. Run it once.
-- ═══════════════════════════════════════════════════════════════

-- ── Replies ────────────────────────────────────────────────────
alter table public.messages
  add column reply_to uuid references public.messages(id) on delete set null,
  add column reply_preview text check (char_length(reply_preview) <= 120);

-- ── Reactions ──────────────────────────────────────────────────
create table public.reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 8),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
alter table public.reactions enable row level security;

create policy "reactions: read"   on public.reactions for select to authenticated
  using (exists (select 1 from public.messages m where m.id = message_id));
create policy "reactions: add"    on public.reactions for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.messages m where m.id = message_id));
create policy "reactions: change" on public.reactions for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.messages m where m.id = message_id));
create policy "reactions: remove" on public.reactions for delete to authenticated
  using (user_id = auth.uid());

-- ── "Save in chat" only works for 5 minutes after opening a snap ─
create or replace function public.save_snap(p_id uuid, p_path text) returns void
language sql security definer set search_path = public as $$
  update public.messages set media_path = p_path, saved_at = now()
  where id = p_id and recipient = auth.uid() and kind <> 'text'
    and opened_at is not null and saved_at is null
    and opened_at > now() - interval '5 minutes'            -- you can only save a snap for 5 minutes after opening it
    and p_path like auth.uid()::text || '/%';
$$;

-- ── Realtime ───────────────────────────────────────────────────
alter publication supabase_realtime add table public.reactions;
