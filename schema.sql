-- ═══════════════════════════════════════════════════════════════
--  Blink — Supabase schema
--  Paste this whole file into  Supabase → SQL Editor → New query → Run.
--  Run it ONCE on a fresh project.
--  (Already ran an older version? Run the files in migrations/ you haven't run yet, in order.)
-- ═══════════════════════════════════════════════════════════════

-- ── Tables ─────────────────────────────────────────────────────
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique check (username ~ '^[a-z0-9_.]{3,20}$'),
  display_name text not null default '',
  avatar_path  text,                                   -- profile picture (file in the public 'avatars' bucket)
  created_at   timestamptz not null default now()
);

create table public.friendships (
  id         uuid primary key default gen_random_uuid(),
  requester  uuid not null references public.profiles(id) on delete cascade,
  addressee  uuid not null references public.profiles(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  check (requester <> addressee)
);
-- only one friendship row per pair of people, whoever asked first
create unique index friendships_pair_idx
  on public.friendships (least(requester, addressee), greatest(requester, addressee));

create table public.groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 40),
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.group_members (
  group_id  uuid not null references public.groups(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_idx on public.group_members (user_id);

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

-- A message is always addressed to ONE recipient. A group message is stored once per member
-- (same group_id + batch_id), which lets every member open their own copy of a snap exactly once.
create table public.messages (
  id         uuid primary key default gen_random_uuid(),
  sender     uuid not null references public.profiles(id) on delete cascade,
  recipient  uuid not null references public.profiles(id) on delete cascade,
  group_id   uuid references public.groups(id) on delete cascade,        -- null = 1-to-1 chat
  batch_id   uuid,                                                       -- ties together the per-member copies of one group message
  kind       text not null,
  body       text not null default '' check (char_length(body) <= 2000), -- chat text, or a snap's caption
  cap_y      real not null default 0.6 check (cap_y between 0 and 1),    -- caption height on the snap (0 = top, 1 = bottom)
  media_path text,                                                       -- file in the 'snaps' bucket
  duration   int  not null default 5 check (duration between 1 and 120), -- seconds a snap can be viewed / length of a voice message
  created_at timestamptz not null default now(),
  opened_at  timestamptz,                                                -- snaps: when the recipient opened it
  read_at    timestamptz,                                                -- text: when the recipient read it
  saved_at   timestamptz,                                                -- kept in the chat (never auto-deleted)
  saved_by   uuid references public.profiles(id) on delete set null,     -- who kept it (they are the only one who can un-save it)
  reply_to   uuid references public.messages(id) on delete set null,     -- the message this one answers (if any)
  reply_preview text check (char_length(reply_preview) <= 120),          -- short text shown in the quote above a reply
  fx         text check (fx is null or fx ~ '^[a-z0-9]{1,16}$'),         -- snap filter (name; the app maps it to a look)
  decor      jsonb not null default '[]'::jsonb,                         -- stickers placed on a snap: [{e, x, y, s}]
  from_roll  boolean not null default false,                             -- snap came from the camera roll (shown as "Media")
  poll_id    uuid references public.polls(id) on delete set null,       -- kind 'poll': the poll this message shows
  check (sender <> recipient),
  check ((group_id is null) = (batch_id is null)),
  constraint messages_kind_check  check (kind in ('text', 'image', 'video', 'voice', 'sticker', 'poll')),
  constraint messages_media_check check ((kind in ('text', 'sticker', 'poll') and media_path is null)
                                      or (kind not in ('text', 'sticker', 'poll') and media_path is not null)),
  constraint messages_poll_check  check ((kind = 'poll') = (poll_id is not null)),
  constraint messages_sticker_check check (kind <> 'sticker' or char_length(body) between 1 and 16),
  constraint messages_decor_check check (jsonb_typeof(decor) = 'array' and jsonb_array_length(decor) <= 8 and length(decor::text) <= 1500)
);
create index messages_sender_idx    on public.messages (sender, recipient, created_at desc);
create index messages_recipient_idx on public.messages (recipient, created_at desc);
create index messages_group_idx     on public.messages (group_id, created_at desc);

-- one emoji reaction per person per message (tap the same one again to remove it)
create table public.reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 8),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- a story: a photo / video all your friends can watch (any number of times) for 24 hours
create table public.stories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('image', 'video')),
  media_path text not null,                                            -- file in the 'snaps' bucket, in the owner's folder
  body       text not null default '' check (char_length(body) <= 200),
  cap_y      real not null default 0.6 check (cap_y between 0 and 1),
  duration   int  not null default 5 check (duration between 1 and 30),
  created_at timestamptz not null default now(),
  fx         text check (fx is null or fx ~ '^[a-z0-9]{1,16}$'),
  decor      jsonb not null default '[]'::jsonb,
  from_roll  boolean not null default false,
  constraint stories_decor_check check (jsonb_typeof(decor) = 'array' and jsonb_array_length(decor) <= 8 and length(decor::text) <= 1500)
);
create index stories_user_idx on public.stories (user_id, created_at desc);

-- who watched which story (only the story's owner can see the list)
create table public.story_views (
  story_id  uuid not null references public.stories(id) on delete cascade,
  viewer    uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, viewer)
);

-- people you blocked: they can't add you, and you no longer see what they send
create table public.blocks (
  blocker    uuid not null references public.profiles(id) on delete cascade,
  blocked    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);

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

-- ── Helper functions ───────────────────────────────────────────
create function public.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester = a and f.addressee = b) or (f.requester = b and f.addressee = a))
  );
$$;

-- has `a` blocked `b`?  (security definer so a policy can look at blocks that belong to somebody else)
create function public.has_blocked(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocks where blocker = a and blocked = b);
$$;

-- is there a block in either direction between these two people?
create function public.is_blocked_pair(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocks
                 where (blocker = a and blocked = b) or (blocker = b and blocked = a));
$$;

create function public.is_group_member(g uuid, u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.group_members where group_id = g and user_id = u);
$$;

-- lets the sign-up form say "username taken" before creating the account
create function public.username_available(p_username text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.profiles where username = lower(p_username));
$$;

-- recipient opens a snap → it can never be fetched again (storage policy below checks opened_at)
create function public.open_snap(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.messages set opened_at = now()
  where id = p_id and recipient = auth.uid() and kind in ('image', 'video') and opened_at is null;
$$;

-- recipient keeps a snap in the chat: the app re-uploads it into the recipient's own folder first
create function public.save_snap(p_id uuid, p_path text) returns void
language sql security definer set search_path = public as $$
  update public.messages set media_path = p_path, saved_at = now(), saved_by = auth.uid()
  where id = p_id and recipient = auth.uid() and kind in ('image', 'video')
    and opened_at is not null and saved_at is null
    and opened_at > now() - interval '5 minutes'            -- you can only save a snap for 5 minutes after opening it
    and p_path like auth.uid()::text || '/%';
$$;

create function public.mark_read(p_friend uuid) returns void
language sql security definer set search_path = public as $$
  update public.messages set read_at = now()
  where sender = p_friend and recipient = auth.uid() and group_id is null
    and kind in ('text', 'voice', 'sticker', 'poll') and read_at is null;
$$;

create function public.mark_read_group(p_group uuid) returns void
language sql security definer set search_path = public as $$
  update public.messages set read_at = now()
  where group_id = p_group and recipient = auth.uid() and kind in ('text', 'voice', 'sticker', 'poll') and read_at is null;
$$;

-- watching a friend's story records you as a viewer
create function public.view_story(p_id uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.story_views (story_id, viewer)
  select s.id, auth.uid() from public.stories s
  where s.id = p_id and s.user_id <> auth.uid()
    and s.created_at > now() - interval '24 hours'
    and public.are_friends(s.user_id, auth.uid())
  on conflict do nothing;
$$;

-- tap a text / voice message to keep it (it is then never auto-deleted); only the person who kept it can un-keep it
create function public.set_saved(p_ids uuid[], p_saved boolean) returns void
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

-- everything that isn't saved disappears after 24 hours. The app first deletes the files, then calls this
-- to delete the rows that involve you.
create function public.purge_expired() returns void
language sql security definer set search_path = public as $$
  delete from public.messages
  where saved_at is null and created_at < now() - interval '24 hours'
    and (sender = auth.uid() or recipient = auth.uid());
  delete from public.polls p
  where p.created_by = auth.uid() and p.created_at < now() - interval '24 hours'
    and not exists (select 1 from public.messages m where m.poll_id = p.id);
$$;

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

-- block someone: they stop being your friend, can't add you again, and what they send you is hidden
create function public.block_user(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or p_user = auth.uid() then raise exception 'Can''t block that person.'; end if;
  insert into public.blocks (blocker, blocked) values (auth.uid(), p_user) on conflict do nothing;
  delete from public.friendships
  where (requester = auth.uid() and addressee = p_user) or (requester = p_user and addressee = auth.uid());
end;
$$;

-- creates a group and its member list in one go; you can only add your own friends (2–9 of them)
create function public.create_group(p_name text, p_members uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  gid uuid; m uuid; ids uuid[]; n int;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if char_length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Give the group a name.'; end if;
  select coalesce(array_agg(distinct x), '{}') into ids from unnest(p_members) x where x <> auth.uid();
  n := coalesce(array_length(ids, 1), 0);
  if n < 2 then raise exception 'Pick at least 2 friends.'; end if;
  if n > 9 then raise exception 'Groups can have up to 10 people.'; end if;
  foreach m in array ids loop
    if not public.are_friends(auth.uid(), m) then raise exception 'You can only add your friends to a group.'; end if;
  end loop;
  insert into public.groups (name, created_by) values (left(trim(p_name), 40), auth.uid()) returning id into gid;
  insert into public.group_members (group_id, user_id) values (gid, auth.uid());
  insert into public.group_members (group_id, user_id) select gid, unnest(ids);
  return gid;
end;
$$;

revoke execute on function
  public.open_snap(uuid), public.save_snap(uuid, text), public.mark_read(uuid), public.mark_read_group(uuid),
  public.create_group(text, uuid[]), public.are_friends(uuid, uuid), public.is_group_member(uuid, uuid),
  public.set_saved(uuid[], boolean), public.purge_expired(), public.block_user(uuid),
  public.has_blocked(uuid, uuid), public.is_blocked_pair(uuid, uuid), public.view_story(uuid),
  public.vote_poll(uuid, int), public.can_bg(text)
  from public, anon;
grant execute on function
  public.open_snap(uuid), public.save_snap(uuid, text), public.mark_read(uuid), public.mark_read_group(uuid),
  public.create_group(text, uuid[]), public.are_friends(uuid, uuid), public.is_group_member(uuid, uuid),
  public.set_saved(uuid[], boolean), public.purge_expired(), public.block_user(uuid),
  public.has_blocked(uuid, uuid), public.is_blocked_pair(uuid, uuid), public.view_story(uuid),
  public.vote_poll(uuid, int), public.can_bg(text)
  to authenticated;
grant execute on function public.username_available(text) to anon, authenticated;

-- ── Create a profile automatically when someone signs up ───────
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    lower(new.raw_user_meta_data ->> 'username'),
    coalesce(new.raw_user_meta_data ->> 'display_name', '')
  );
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- when the last member leaves, the group (and its messages) goes away
create function public.cleanup_empty_group() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.groups g
  where g.id = old.group_id
    and not exists (select 1 from public.group_members where group_id = old.group_id);
  return old;
end;
$$;
create trigger on_member_left
  after delete on public.group_members
  for each row execute function public.cleanup_empty_group();

-- ── Row Level Security: who may see / change what ──────────────
alter table public.profiles      enable row level security;
alter table public.friendships   enable row level security;
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.messages      enable row level security;
alter table public.reactions     enable row level security;
alter table public.blocks        enable row level security;
alter table public.stories       enable row level security;
alter table public.story_views   enable row level security;
alter table public.polls            enable row level security;
alter table public.poll_votes       enable row level security;
alter table public.best_friends     enable row level security;
alter table public.chat_backgrounds enable row level security;

-- profiles: any signed-in user can look people up by username; you can only edit your own
create policy "profiles: read"        on public.profiles for select to authenticated using (true);
create policy "profiles: update own"  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- friendships: you see yours, you can ask, only the person asked can accept, either can end it
create policy "friendships: read"   on public.friendships for select to authenticated
  using (requester = auth.uid() or addressee = auth.uid());
create policy "friendships: ask"    on public.friendships for insert to authenticated
  with check (requester = auth.uid() and status = 'pending' and not public.is_blocked_pair(requester, addressee));
create policy "friendships: accept" on public.friendships for update to authenticated
  using (addressee = auth.uid()) with check (addressee = auth.uid() and status = 'accepted');
create policy "friendships: end"    on public.friendships for delete to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

-- groups: members can see their groups and who is in them; groups are created through create_group(),
-- and you can leave (but not remove other people)
create policy "groups: read"        on public.groups for select to authenticated
  using (public.is_group_member(id, auth.uid()));
create policy "group_members: read" on public.group_members for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));
create policy "group_members: leave" on public.group_members for delete to authenticated
  using (user_id = auth.uid());

-- messages: you see the ones you sent/received. 1-to-1: only to accepted friends.
-- Group: only from a member to another member. A snap's file must live in YOUR own storage folder.
create policy "messages: read" on public.messages for select to authenticated
  using ((sender = auth.uid() or recipient = auth.uid()) and not public.has_blocked(auth.uid(), sender));
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
-- (no update/delete policy on messages: opened/read/saved are set only through the functions above)

-- reactions: you can see reactions on messages you can see, and add / change / remove only your own
create policy "reactions: read"   on public.reactions for select to authenticated
  using (exists (select 1 from public.messages m where m.id = message_id) and not public.has_blocked(auth.uid(), user_id));
create policy "reactions: add"    on public.reactions for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.messages m where m.id = message_id));
create policy "reactions: change" on public.reactions for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.messages m where m.id = message_id));
create policy "reactions: remove" on public.reactions for delete to authenticated
  using (user_id = auth.uid());

-- blocks: you can see, add and remove only your own (adding goes through block_user())
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

create policy "blocks: read"   on public.blocks for select to authenticated using (blocker = auth.uid());
create policy "blocks: add"    on public.blocks for insert to authenticated with check (blocker = auth.uid());
create policy "blocks: remove" on public.blocks for delete to authenticated using (blocker = auth.uid());

-- stories: you see your own and your friends' (for 24 h); you add and delete only your own
create policy "stories: read" on public.stories for select to authenticated
  using (user_id = auth.uid()
         or (created_at > now() - interval '24 hours' and public.are_friends(user_id, auth.uid())));
create policy "stories: add" on public.stories for insert to authenticated
  with check (user_id = auth.uid() and media_path like auth.uid()::text || '/%');
create policy "stories: remove" on public.stories for delete to authenticated using (user_id = auth.uid());

-- story views: you see your own views, and the views of your own stories (rows are added through view_story())
create policy "story_views: read" on public.story_views for select to authenticated
  using (viewer = auth.uid() or exists (select 1 from public.stories s where s.id = story_id and s.user_id = auth.uid()));

-- ── Storage: private bucket for snaps ──────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('snaps', 'snaps', false, 52428800,
        array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime',
              'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/x-m4a', 'audio/wav'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "snaps: upload to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'snaps' and (storage.foldername(name))[1] = auth.uid()::text);

-- you can read your own uploads (incl. snaps you saved), a snap sent to you — but only until you've
-- opened it —, a snap that was saved in the chat you share with the sender, and voice messages in your chats
create policy "snaps: read" on storage.objects for select to authenticated
  using (
    bucket_id = 'snaps' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.messages m
                 where m.media_path = name
                   and ((m.recipient = auth.uid() and m.opened_at is null)
                        or (m.saved_at is not null and (m.sender = auth.uid() or m.recipient = auth.uid()))
                        or (m.kind = 'voice' and (m.sender = auth.uid() or m.recipient = auth.uid()))))
      or exists (select 1 from public.stories s
                 where s.media_path = name and s.created_at > now() - interval '24 hours'
                   and public.are_friends(s.user_id, auth.uid()))
    )
  );

-- the app deletes a snap's file right after downloading it (before marking it opened).
-- NB: Postgres only lets you delete rows you can also read, so this has to happen while the snap is still unopened.
create policy "snaps: delete" on storage.objects for delete to authenticated
  using (
    bucket_id = 'snaps' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.messages m
                 where m.media_path = name and m.recipient = auth.uid())
    )
  );

-- ── Storage: public bucket for profile pictures (small square JPEGs) ──
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "avatars: read"   on storage.objects for select to anon, authenticated using (bucket_id = 'avatars');
create policy "avatars: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

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

-- ── Realtime: push new messages / friend requests / groups to open apps ─
alter publication supabase_realtime add table
  public.messages, public.friendships, public.groups, public.group_members, public.reactions,
  public.stories, public.story_views, public.poll_votes, public.chat_backgrounds;
