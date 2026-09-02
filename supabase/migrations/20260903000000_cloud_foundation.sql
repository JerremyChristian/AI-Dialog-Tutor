-- M6.4 cloud foundation. Application snapshots remain local until M6.5.
create extension if not exists pgcrypto;

create table if not exists public.lessons (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  lesson_focus text,
  has_started boolean not null default false,
  snapshot_schema_version integer not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table if not exists public.lesson_sources (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  storage_path text not null,
  role text,
  created_at timestamptz not null default now(),
  constraint lesson_sources_owned_lesson_fk
    foreign key (lesson_id, user_id)
    references public.lessons(id, user_id)
    on delete cascade,
  unique (storage_path)
);

create index if not exists lessons_user_updated_idx
  on public.lessons (user_id, updated_at desc);
create index if not exists lesson_sources_user_idx
  on public.lesson_sources (user_id);
create index if not exists lesson_sources_lesson_idx
  on public.lesson_sources (lesson_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists lessons_set_updated_at on public.lessons;
create trigger lessons_set_updated_at
before update on public.lessons
for each row execute function public.set_updated_at();

alter table public.lessons enable row level security;
alter table public.lesson_sources enable row level security;

revoke all on public.lessons from anon;
revoke all on public.lesson_sources from anon;
grant select, insert, update, delete on public.lessons to authenticated;
grant select, insert, update, delete on public.lesson_sources to authenticated;

drop policy if exists "Users read own lessons" on public.lessons;
create policy "Users read own lessons" on public.lessons
for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users create own lessons" on public.lessons;
create policy "Users create own lessons" on public.lessons
for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users update own lessons" on public.lessons;
create policy "Users update own lessons" on public.lessons
for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
drop policy if exists "Users delete own lessons" on public.lessons;
create policy "Users delete own lessons" on public.lessons
for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Users read own lesson sources" on public.lesson_sources;
create policy "Users read own lesson sources" on public.lesson_sources
for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users create own lesson sources" on public.lesson_sources;
create policy "Users create own lesson sources" on public.lesson_sources
for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users update own lesson sources" on public.lesson_sources;
create policy "Users update own lesson sources" on public.lesson_sources
for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
drop policy if exists "Users delete own lesson sources" on public.lesson_sources;
create policy "Users delete own lesson sources" on public.lesson_sources
for delete to authenticated using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lesson-sources',
  'lesson-sources',
  false,
  20971520,
  array['application/pdf', 'text/plain']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users read own lesson source objects" on storage.objects;
create policy "Users read own lesson source objects" on storage.objects
for select to authenticated
using (
  bucket_id = 'lesson-sources'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
drop policy if exists "Users upload own lesson source objects" on storage.objects;
create policy "Users upload own lesson source objects" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'lesson-sources'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
drop policy if exists "Users update own lesson source objects" on storage.objects;
create policy "Users update own lesson source objects" on storage.objects
for update to authenticated
using (
  bucket_id = 'lesson-sources'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'lesson-sources'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
drop policy if exists "Users delete own lesson source objects" on storage.objects;
create policy "Users delete own lesson source objects" on storage.objects
for delete to authenticated
using (
  bucket_id = 'lesson-sources'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
