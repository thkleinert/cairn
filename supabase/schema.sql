-- Enable required extensions
create extension if not exists "uuid-ossp";

-- ============================================================
-- TABLES
-- ============================================================

create table public.trips (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  description text,
  start_date  date,
  end_date    date,
  status      text not null default 'planning' check (status in ('planning','ongoing','completed')),
  share_token uuid unique default uuid_generate_v4(),
  cover_image_url text,
  owner_id    uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.trip_members (
  id        uuid primary key default uuid_generate_v4(),
  trip_id   uuid not null references public.trips(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'editor' check (role in ('owner','editor','viewer')),
  joined_at timestamptz not null default now(),
  unique (trip_id, user_id)
);

create table public.tags (
  id      uuid primary key default uuid_generate_v4(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  name    text not null,
  color   text not null default '#6366f1',
  unique (trip_id, name)
);

create table public.places (
  id              uuid primary key default uuid_generate_v4(),
  trip_id         uuid not null references public.trips(id) on delete cascade,
  name            text not null,
  address         text,
  latitude        double precision not null,
  longitude       double precision not null,
  google_place_id text,
  status          text not null default 'planned' check (status in ('planned','visited')),
  visited_at      timestamptz,
  notes           text,
  source_url      text,
  image_url       text,
  added_by        uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.place_tags (
  place_id uuid not null references public.places(id) on delete cascade,
  tag_id   uuid not null references public.tags(id) on delete cascade,
  primary key (place_id, tag_id)
);

-- ============================================================
-- UPDATED_AT TRIGGERS
-- ============================================================

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trips_updated_at before update on public.trips
  for each row execute function public.set_updated_at();

create trigger places_updated_at before update on public.places
  for each row execute function public.set_updated_at();

-- ============================================================
-- AUTO-ADD OWNER AS MEMBER
-- ============================================================

create or replace function public.add_trip_owner_as_member()
returns trigger language plpgsql security definer as $$
begin
  insert into public.trip_members (trip_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end;
$$;

create trigger trip_created after insert on public.trips
  for each row execute function public.add_trip_owner_as_member();

-- ============================================================
-- HELPER: is_trip_member
-- ============================================================

create or replace function public.is_trip_member(trip uuid, usr uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.trip_members
    where trip_id = trip and user_id = usr
  );
$$;

-- ============================================================
-- RLS
-- ============================================================

alter table public.trips enable row level security;
alter table public.trip_members enable row level security;
alter table public.tags enable row level security;
alter table public.places enable row level security;
alter table public.place_tags enable row level security;

-- trips: members can read; owners can write; public share token read
create policy "trip_select" on public.trips for select
  using (
    public.is_trip_member(id, auth.uid())
    or share_token::text = current_setting('request.jwt.claims', true)::json->>'share_token'
  );

create policy "trip_insert" on public.trips for insert
  with check (owner_id = auth.uid());

create policy "trip_update" on public.trips for update
  using (public.is_trip_member(id, auth.uid()))
  with check (public.is_trip_member(id, auth.uid()));

create policy "trip_delete" on public.trips for delete
  using (owner_id = auth.uid());

-- trip_members
create policy "tm_select" on public.trip_members for select
  using (public.is_trip_member(trip_id, auth.uid()));

create policy "tm_insert" on public.trip_members for insert
  with check (
    exists (
      select 1 from public.trips t
      where t.id = trip_id and t.owner_id = auth.uid()
    )
  );

create policy "tm_delete" on public.trip_members for delete
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.trips t
      where t.id = trip_id and t.owner_id = auth.uid()
    )
  );

-- tags
create policy "tags_select" on public.tags for select
  using (public.is_trip_member(trip_id, auth.uid()));

create policy "tags_insert" on public.tags for insert
  with check (public.is_trip_member(trip_id, auth.uid()));

create policy "tags_update" on public.tags for update
  using (public.is_trip_member(trip_id, auth.uid()));

create policy "tags_delete" on public.tags for delete
  using (public.is_trip_member(trip_id, auth.uid()));

-- places
create policy "places_select" on public.places for select
  using (public.is_trip_member(trip_id, auth.uid()));

create policy "places_insert" on public.places for insert
  with check (public.is_trip_member(trip_id, auth.uid()));

create policy "places_update" on public.places for update
  using (public.is_trip_member(trip_id, auth.uid()));

create policy "places_delete" on public.places for delete
  using (public.is_trip_member(trip_id, auth.uid()));

-- place_tags
create policy "place_tags_select" on public.place_tags for select
  using (
    exists (
      select 1 from public.places p
      where p.id = place_id and public.is_trip_member(p.trip_id, auth.uid())
    )
  );

create policy "place_tags_insert" on public.place_tags for insert
  with check (
    exists (
      select 1 from public.places p
      where p.id = place_id and public.is_trip_member(p.trip_id, auth.uid())
    )
  );

create policy "place_tags_delete" on public.place_tags for delete
  using (
    exists (
      select 1 from public.places p
      where p.id = place_id and public.is_trip_member(p.trip_id, auth.uid())
    )
  );

-- ============================================================
-- PUBLIC SHARE VIEW (bypasses RLS via share token)
-- ============================================================

create or replace view public.public_trip_view as
  select
    t.id,
    t.name,
    t.description,
    t.start_date,
    t.end_date,
    t.status,
    t.share_token,
    t.cover_image_url
  from public.trips t;

-- ============================================================
-- INDEXES
-- ============================================================

create index trips_owner_id_idx on public.trips(owner_id);
create index trip_members_user_id_idx on public.trip_members(user_id);
create index places_trip_id_idx on public.places(trip_id);
create index places_google_place_id_idx on public.places(google_place_id);
create index tags_trip_id_idx on public.tags(trip_id);
