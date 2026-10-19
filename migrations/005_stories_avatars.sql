-- ═══════════════════════════════════════════════════════════════
--  Blink — migration 005: stories and profile pictures
--
--  For projects that already ran schema.sql AND migrations 002, 003 and 004.
--  (Brand-new project? Just run schema.sql — it already includes all of this.)
--  Paste into Supabase → SQL Editor → New query → Run. Run it once.
-- ═══════════════════════════════════════════════════════════════

-- ── Profile pictures ───────────────────────────────────────────
alter table public.profiles add column avatar_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "avatars: read"   on storage.objects for select to anon, authenticated using (bucket_id = 'avatars');
create policy "avatars: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ── Stories ────────────────────────────────────────────────────
create table public.stories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('image', 'video')),
  media_path text not null,
  body       text not null default '' check (char_length(body) <= 200),
  cap_y      real not null default 0.6 check (cap_y between 0 and 1),
  duration   int  not null default 5 check (duration between 1 and 30),
  created_at timestamptz not null default now()
);
create index stories_user_idx on public.stories (user_id, created_at desc);

create table public.story_views (
  story_id  uuid not null references public.stories(id) on delete cascade,
  viewer    uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, viewer)
);

alter table public.stories     enable row level security;
alter table public.story_views enable row level security;

create function public.view_story(p_id uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.story_views (story_id, viewer)
  select s.id, auth.uid() from public.stories s
  where s.id = p_id and s.user_id <> auth.uid()
    and s.created_at > now() - interval '24 hours'
    and public.are_friends(s.user_id, auth.uid())
  on conflict do nothing;
$$;
revoke execute on function public.view_story(uuid) from public, anon;
grant execute on function public.view_story(uuid) to authenticated;

create policy "stories: read" on public.stories for select to authenticated
  using (user_id = auth.uid()
         or (created_at > now() - interval '24 hours' and public.are_friends(user_id, auth.uid())));
create policy "stories: add" on public.stories for insert to authenticated
  with check (user_id = auth.uid() and media_path like auth.uid()::text || '/%');
create policy "stories: remove" on public.stories for delete to authenticated using (user_id = auth.uid());

create policy "story_views: read" on public.story_views for select to authenticated
  using (viewer = auth.uid() or exists (select 1 from public.stories s where s.id = story_id and s.user_id = auth.uid()));

-- friends can download a story's file for 24 hours
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
      or exists (select 1 from public.stories s
                 where s.media_path = name and s.created_at > now() - interval '24 hours'
                   and public.are_friends(s.user_id, auth.uid()))
    )
  );

alter publication supabase_realtime add table public.stories, public.story_views;
