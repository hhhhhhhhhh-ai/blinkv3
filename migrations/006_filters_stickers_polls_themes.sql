-- ═══════════════════════════════════════════════════════════════
--  Blink — migration 006: filters, stickers, polls, best friends, shared chat backgrounds, "Media" label
--
--  For projects that already ran schema.sql AND migrations 002 – 005.
--  (Brand-new project? Just run schema.sql — it already includes all of this.)
--  Paste into Supabase → SQL Editor → New query → Run. Run it once.
-- ═══════════════════════════════════════════════════════════════

-- a poll: one question with 2–6 options. In a group every member's copy of the poll message points to the same poll row.
create function public.poll_options_ok(o text[]) returns boolean
language sql immutable as $$
  select coalesce(bool_and(char_length(x) between 1 and 60), false) from unnest(o) x;
$$;

create table public.polls (
  id         uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete cascade,
  question   text not null check (char_length(question) between 1 and 200),
  options    text[] not null check (array_length(options, 1) between 2 and 6 and public.poll_options_ok(options)),
  created_at timestamptz not null default now()
);

-- ── Messages: stickers + polls, filter, stickers placed on a snap, "Media" (camera roll) flag ──
alter table public.messages
  add column fx        text check (fx is null or fx ~ '^[a-z0-9]{1,16}$'),
  add column decor     jsonb not null default '[]'::jsonb,
  add column from_roll boolean not null default false,
  add column poll_id   uuid references public.polls(id) on delete set null;

alter table public.messages drop constraint messages_kind_check;
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.messages'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%media_path IS NULL%' and conname <> 'messages_media_check'
  loop execute format('alter table public.messages drop constraint %I', c); end loop;
end $$;
alter table public.messages
  add constraint messages_kind_check  check (kind in ('text', 'image', 'video', 'voice', 'sticker', 'poll')),
  add constraint messages_media_check check ((kind in ('text', 'sticker', 'poll') and media_path is null)
                                          or (kind not in ('text', 'sticker', 'poll') and media_path is not null)),
  add constraint messages_poll_check  check ((kind = 'poll') = (poll_id is not null)),
  add constraint messages_sticker_check check (kind <> 'sticker' or char_length(body) between 1 and 16),
  add constraint messages_decor_check check (jsonb_typeof(decor) = 'array' and jsonb_array_length(decor) <= 8 and length(decor::text) <= 1500);

alter table public.stories
  add column fx        text check (fx is null or fx ~ '^[a-z0-9]{1,16}$'),
  add column decor     jsonb not null default '[]'::jsonb,
  add column from_roll boolean not null default false,
  add constraint stories_decor_check check (jsonb_typeof(decor) = 'array' and jsonb_array_length(decor) <= 8 and length(decor::text) <= 1500);

-- one vote per person per poll (voting again for the same option takes it back); written only through vote_poll()
create table public.poll_votes (
  poll_id  uuid not null references public.polls(id) on delete cascade,
  voter    uuid not null references public.profiles(id) on delete cascade,
  opt      int  not null check (opt between 0 and 5),
  voted_at timestamptz not null default now(),
  primary key (poll_id, voter)
);

-- your private "best friends" shortlist (they are not told)
create table public.best_friends (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  friend_id  uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);

-- a chat background everyone in the chat sees. scope: 'g:<group id>' or 'd:<smaller user id>:<larger user id>'.
-- No row = the normal themed background.
create table public.chat_backgrounds (
  scope      text primary key check (
    scope ~ '^(g:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|d:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  kind       text not null check (kind in ('preset', 'image')),
  value      text not null check (char_length(value) between 1 and 200),
  set_by     uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint chat_backgrounds_order_check check (scope not like 'd:%' or split_part(scope, ':', 2)::uuid < split_part(scope, ':', 3)::uuid)
);

alter table public.polls            enable row level security;
alter table public.poll_votes       enable row level security;
alter table public.best_friends     enable row level security;
alter table public.chat_backgrounds enable row level security;

-- may I look at / change the background of this chat?
create function public.can_bg(p_scope text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_scope like 'g:%' then public.is_group_member(split_part(p_scope, ':', 2)::uuid, auth.uid())
    when p_scope like 'd:%' then auth.uid() in (split_part(p_scope, ':', 2)::uuid, split_part(p_scope, ':', 3)::uuid)
         and public.are_friends(split_part(p_scope, ':', 2)::uuid, split_part(p_scope, ':', 3)::uuid)
    else false end;
$$;

-- vote in a poll you were sent (or sent): pick an option, change your mind, or tap your option again to take the vote back
create function public.vote_poll(p_poll uuid, p_opt int) returns void
language plpgsql security definer set search_path = public as $$
declare n int; cur int;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from public.messages m
                 where m.poll_id = p_poll and (m.recipient = auth.uid() or m.sender = auth.uid())) then
    raise exception 'You can''t vote in this poll.';
  end if;
  select array_length(options, 1) into n from public.polls where id = p_poll;
  if n is null or p_opt is null or p_opt < 0 or p_opt >= n then raise exception 'Pick one of the options.'; end if;
  select opt into cur from public.poll_votes where poll_id = p_poll and voter = auth.uid();
  if cur = p_opt then
    delete from public.poll_votes where poll_id = p_poll and voter = auth.uid();
  else
    insert into public.poll_votes (poll_id, voter, opt) values (p_poll, auth.uid(), p_opt)
    on conflict (poll_id, voter) do update set opt = excluded.opt, voted_at = now();
  end if;
end;
$$;

create or replace function public.mark_read(p_friend uuid) returns void
language sql security definer set search_path = public as $$
  update public.messages set read_at = now()
  where sender = p_friend and recipient = auth.uid() and group_id is null
    and kind in ('text', 'voice', 'sticker', 'poll') and read_at is null;
$$;

create or replace function public.mark_read_group(p_group uuid) returns void
language sql security definer set search_path = public as $$
  update public.messages set read_at = now()
  where group_id = p_group and recipient = auth.uid() and kind in ('text', 'voice', 'sticker', 'poll') and read_at is null;
$$;

create or replace function public.set_saved(p_ids uuid[], p_saved boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_saved then
    update public.messages set saved_at = now(), saved_by = auth.uid()
    where id = any(p_ids) and kind in ('text', 'voice', 'sticker', 'poll') and saved_at is null
      and (sender = auth.uid() or recipient = auth.uid());
  else
    update public.messages set saved_at = null, saved_by = null
    where id = any(p_ids) and kind in ('text', 'voice', 'sticker', 'poll') and saved_by = auth.uid();
  end if;
end;
$$;

create or replace function public.purge_expired() returns void
language sql security definer set search_path = public as $$
  delete from public.messages
  where saved_at is null and created_at < now() - interval '24 hours'
    and (sender = auth.uid() or recipient = auth.uid());
  delete from public.polls p
  where p.created_by = auth.uid() and p.created_at < now() - interval '24 hours'
    and not exists (select 1 from public.messages m where m.poll_id = p.id);
$$;

revoke execute on function public.vote_poll(uuid, int), public.can_bg(text) from public, anon;
grant execute on function public.vote_poll(uuid, int), public.can_bg(text) to authenticated;

create policy "polls: read" on public.polls for select to authenticated
  using (created_by = auth.uid() or exists (select 1 from public.messages m where m.poll_id = polls.id));
create policy "polls: add"  on public.polls for insert to authenticated with check (created_by = auth.uid());

create policy "poll_votes: read" on public.poll_votes for select to authenticated
  using (exists (select 1 from public.polls p where p.id = poll_id) and not public.has_blocked(auth.uid(), voter));

alter table public.best_friends enable row level security;
create policy "best_friends: read"   on public.best_friends for select to authenticated using (user_id = auth.uid());
create policy "best_friends: add"    on public.best_friends for insert to authenticated
  with check (user_id = auth.uid() and public.are_friends(user_id, friend_id)
              and (select count(*) from public.best_friends b where b.user_id = auth.uid()) < 8);
create policy "best_friends: remove" on public.best_friends for delete to authenticated using (user_id = auth.uid());

create policy "chat_bg: read"   on public.chat_backgrounds for select to authenticated using (public.can_bg(scope));
create policy "chat_bg: add"    on public.chat_backgrounds for insert to authenticated
  with check (public.can_bg(scope) and set_by = auth.uid());
create policy "chat_bg: change" on public.chat_backgrounds for update to authenticated
  using (public.can_bg(scope)) with check (public.can_bg(scope) and set_by = auth.uid());
create policy "chat_bg: remove" on public.chat_backgrounds for delete to authenticated using (public.can_bg(scope));

drop policy "messages: send" on public.messages;
create policy "messages: send" on public.messages for insert to authenticated
  with check (
    sender = auth.uid()
    and opened_at is null and read_at is null and saved_at is null
    and (media_path is null or media_path like sender::text || '/%')
    and (poll_id is null or exists (select 1 from public.polls p where p.id = poll_id and p.created_by = sender))
    and (
      (group_id is null and public.are_friends(sender, recipient))
      or (group_id is not null and public.is_group_member(group_id, sender) and public.is_group_member(group_id, recipient))
    )
  );

-- ── Storage: public bucket for custom chat backgrounds (shared by everybody in the chat) ──
-- folder = the chat's scope with ':' written as '_' (g_<group id>  or  d_<user id>_<user id>)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chatbg', 'chatbg', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "chatbg: read"   on storage.objects for select to anon, authenticated using (bucket_id = 'chatbg');
create policy "chatbg: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'chatbg' and public.can_bg(replace((storage.foldername(name))[1], '_', ':')));
create policy "chatbg: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'chatbg' and public.can_bg(replace((storage.foldername(name))[1], '_', ':')));

alter publication supabase_realtime add table public.poll_votes, public.chat_backgrounds;
