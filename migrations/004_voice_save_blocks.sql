-- ═══════════════════════════════════════════════════════════════
--  Blink — migration 004: voice messages, tap-to-save chats, 24-hour expiry, blocking
--
--  For projects that already ran schema.sql (version 1) AND migrations 002 + 003.
--  (Brand-new project? Just run schema.sql — it already includes all of this.)
--  Paste into Supabase → SQL Editor → New query → Run. Run it once.
-- ═══════════════════════════════════════════════════════════════

-- ── Voice messages + who saved a message ───────────────────────
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check check (kind in ('text', 'image', 'video', 'voice'));
alter table public.messages drop constraint if exists messages_duration_check;
alter table public.messages add constraint messages_duration_check check (duration between 1 and 120);
alter table public.messages add column saved_by uuid references public.profiles(id) on delete set null;
update public.messages set saved_by = recipient where saved_at is not null;

-- ── Blocking ───────────────────────────────────────────────────
create table public.blocks (
  blocker    uuid not null references public.profiles(id) on delete cascade,
  blocked    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);
alter table public.blocks enable row level security;

create function public.has_blocked(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocks where blocker = a and blocked = b);
$$;

create function public.is_blocked_pair(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocks
                 where (blocker = a and blocked = b) or (blocker = b and blocked = a));
$$;

-- ── Functions (replaced / new) ─────────────────────────────────
create or replace function public.open_snap(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.messages set opened_at = now()
  where id = p_id and recipient = auth.uid() and kind in ('image', 'video') and opened_at is null;
$$;

create or replace function public.save_snap(p_id uuid, p_path text) returns void
language sql security definer set search_path = public as $$
  update public.messages set media_path = p_path, saved_at = now(), saved_by = auth.uid()
  where id = p_id and recipient = auth.uid() and kind in ('image', 'video')
    and opened_at is not null and saved_at is null
    and opened_at > now() - interval '5 minutes'            -- you can only save a snap for 5 minutes after opening it
    and p_path like auth.uid()::text || '/%';
$$;

create or replace function public.mark_read(p_friend uuid) returns void
language sql security definer set search_path = public as $$
  update public.messages set read_at = now()
  where sender = p_friend and recipient = auth.uid() and group_id is null
    and kind in ('text', 'voice') and read_at is null;
$$;

create or replace function public.mark_read_group(p_group uuid) returns void
language sql security definer set search_path = public as $$
  update public.messages set read_at = now()
  where group_id = p_group and recipient = auth.uid() and kind in ('text', 'voice') and read_at is null;
$$;

create function public.set_saved(p_ids uuid[], p_saved boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_saved then
    update public.messages set saved_at = now(), saved_by = auth.uid()
    where id = any(p_ids) and kind in ('text', 'voice') and saved_at is null
      and (sender = auth.uid() or recipient = auth.uid());
  else
    update public.messages set saved_at = null, saved_by = null
    where id = any(p_ids) and kind in ('text', 'voice') and saved_by = auth.uid();
  end if;
end;
$$;

create function public.purge_expired() returns void
language sql security definer set search_path = public as $$
  delete from public.messages
  where saved_at is null and created_at < now() - interval '24 hours'
    and (sender = auth.uid() or recipient = auth.uid());
$$;

create function public.block_user(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or p_user = auth.uid() then raise exception 'Can''t block that person.'; end if;
  insert into public.blocks (blocker, blocked) values (auth.uid(), p_user) on conflict do nothing;
  delete from public.friendships
  where (requester = auth.uid() and addressee = p_user) or (requester = p_user and addressee = auth.uid());
end;
$$;

revoke execute on function
  public.set_saved(uuid[], boolean), public.purge_expired(), public.block_user(uuid),
  public.has_blocked(uuid, uuid), public.is_blocked_pair(uuid, uuid)
  from public, anon;
grant execute on function
  public.set_saved(uuid[], boolean), public.purge_expired(), public.block_user(uuid),
  public.has_blocked(uuid, uuid), public.is_blocked_pair(uuid, uuid)
  to authenticated;

-- ── Policies (replaced / new) ──────────────────────────────────
drop policy "friendships: ask" on public.friendships;
create policy "friendships: ask"    on public.friendships for insert to authenticated
  with check (requester = auth.uid() and status = 'pending' and not public.is_blocked_pair(requester, addressee));

drop policy "messages: read" on public.messages;
create policy "messages: read" on public.messages for select to authenticated
  using ((sender = auth.uid() or recipient = auth.uid()) and not public.has_blocked(auth.uid(), sender));

drop policy "reactions: read" on public.reactions;
create policy "reactions: read"   on public.reactions for select to authenticated
  using (exists (select 1 from public.messages m where m.id = message_id) and not public.has_blocked(auth.uid(), user_id));

create policy "blocks: read"   on public.blocks for select to authenticated using (blocker = auth.uid());
create policy "blocks: add"    on public.blocks for insert to authenticated with check (blocker = auth.uid());
create policy "blocks: remove" on public.blocks for delete to authenticated using (blocker = auth.uid());

-- ── Storage: allow audio + let both people in a chat read voice messages ──
update storage.buckets
  set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime',
                                 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/x-m4a', 'audio/wav']
  where id = 'snaps';

drop policy "snaps: read" on storage.objects;
create policy "snaps: read" on storage.objects for select to authenticated
  using (
    bucket_id = 'snaps' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.messages m
                 where m.media_path = name
                   and ((m.recipient = auth.uid() and m.opened_at is null)
                        or (m.saved_at is not null and (m.sender = auth.uid() or m.recipient = auth.uid()))
                        or (m.kind = 'voice' and (m.sender = auth.uid() or m.recipient = auth.uid()))))
    )
  );
