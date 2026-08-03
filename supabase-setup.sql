-- Animation Coach cloud sync schema.
-- Run this once in the Supabase SQL editor for project ckprenvvhxgjvutnjevl.

create table if not exists public.animation_projects (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  name text not null default '無題のプロジェクト',
  project_data jsonb not null,
  media_manifest jsonb not null default '{}'::jsonb,
  client_updated_at bigint not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.animation_projects enable row level security;

revoke all on table public.animation_projects from anon;
grant select, insert, update, delete on table public.animation_projects to authenticated;

drop policy if exists "Users can read their Animation Coach projects" on public.animation_projects;
create policy "Users can read their Animation Coach projects"
on public.animation_projects for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their Animation Coach projects" on public.animation_projects;
create policy "Users can create their Animation Coach projects"
on public.animation_projects for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their Animation Coach projects" on public.animation_projects;
create policy "Users can update their Animation Coach projects"
on public.animation_projects for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their Animation Coach projects" on public.animation_projects;
create policy "Users can delete their Animation Coach projects"
on public.animation_projects for delete
to authenticated
using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public)
values ('animation-coach-media', 'animation-coach-media', false)
on conflict (id) do update set public = false;

drop policy if exists "Users can read their Animation Coach media" on storage.objects;
create policy "Users can read their Animation Coach media"
on storage.objects for select
to authenticated
using (
  bucket_id = 'animation-coach-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users can upload their Animation Coach media" on storage.objects;
create policy "Users can upload their Animation Coach media"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'animation-coach-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users can update their Animation Coach media" on storage.objects;
create policy "Users can update their Animation Coach media"
on storage.objects for update
to authenticated
using (
  bucket_id = 'animation-coach-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'animation-coach-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users can delete their Animation Coach media" on storage.objects;
create policy "Users can delete their Animation Coach media"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'animation-coach-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
