-- Crystal Studio: shared online storage (run once in Supabase → SQL Editor → New query → Run).
-- Safe to run again: it only adds what's missing.
--
--   crystal_library   the imported crystal designs (one row each: its JSON in "item")
--   crystal_designs   designs saved with Save (an Excel list + changes)
--   crystal_settings  the master template ("master") and the font names ("fonts")
--   storage "crystal" the designs' pictures, the imported .ai copies, font files (fonts/)
--
-- Who can change things: ANYONE who opens Crystal Studio (no login), as asked.
-- Saved designs hold the Excel rows (students' names). Fine with test data; before real orders go
-- in, change the policies below to "authenticated" (logged-in staff) instead of "anon".

create table if not exists public.crystal_library (
  id text primary key,
  item jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.crystal_designs (
  id text primary key,
  meta jsonb not null,
  design jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.crystal_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.crystal_library, public.crystal_designs, public.crystal_settings to anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['crystal_library', 'crystal_designs', 'crystal_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "crystal studio: anyone" on public.%I', t);
    execute format('create policy "crystal studio: anyone" on public.%I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- the files: public to read (the pictures show on the order website), 50 MB a file at most
insert into storage.buckets (id, name, public, file_size_limit)
values ('crystal', 'crystal', true, 52428800)
on conflict (id) do update set public = true, file_size_limit = 52428800;

drop policy if exists "crystal studio files: read" on storage.objects;
drop policy if exists "crystal studio files: add" on storage.objects;
drop policy if exists "crystal studio files: change" on storage.objects;
drop policy if exists "crystal studio files: remove" on storage.objects;
create policy "crystal studio files: read" on storage.objects for select to anon, authenticated using (bucket_id = 'crystal');
create policy "crystal studio files: add" on storage.objects for insert to anon, authenticated with check (bucket_id = 'crystal');
create policy "crystal studio files: change" on storage.objects for update to anon, authenticated using (bucket_id = 'crystal') with check (bucket_id = 'crystal');
create policy "crystal studio files: remove" on storage.objects for delete to anon, authenticated using (bucket_id = 'crystal');
