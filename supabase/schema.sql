-- ============================================================
-- Cairn — complete database schema
-- ------------------------------------------------------------
-- Run this ONCE, in full, on a fresh Supabase project (SQL Editor).
-- It creates every table, Row Level Security policy, RPC, trigger, the
-- storage bucket, and the realtime publication the app needs.
--
-- It is deliberately NOT idempotent: plain `create table` / `create policy`
-- statements mean a second run fails on the first object that already
-- exists. That's the intended safety property — it will not silently
-- half-apply over a database that already has data.
-- ============================================================

-- Enable required extensions
create extension if not exists "uuid-ossp";

-- ============================================================
-- TABLES
-- ============================================================

create table public.trips (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  description text,
  -- Free-form trip-wide scratchpad, distinct from `description` (a short
  -- subtitle shown in the trip list). This is where door codes, booking refs
  -- and arrival times land, which is why it is scrubbed from get_shared_trip.
  notes       text,
  start_date  date,
  end_date    date,
  share_token uuid unique default uuid_generate_v4(),
  cover_image_url text,
  owner_id    uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint trips_dates_ordered check (start_date is null or end_date is null or end_date >= start_date)
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
  icon    text,
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
  -- Anchors this place inside another — a café in the city it's in. Used by
  -- the notes page to nest it under its parent's heading instead of giving it
  -- a top-level section of its own. The composite FK below keeps parent and
  -- child in the same trip; `on delete set null` so deleting a city releases
  -- its cafés rather than deleting them.
  parent_place_id uuid,
  -- What this place IS: somewhere you go, or somewhere inside one of those.
  -- A stop is a city, an island, a park; a spot is a café, a hotel, a
  -- viewpoint. The list view nests spots under their stop, and the map can
  -- hide them. Recorded once at creation rather than re-derived on every read:
  -- the guess comes from Google's own place types, and the row is what the
  -- user may then have corrected.
  kind            text not null default 'stop',
  status          text not null default 'planned' check (status in ('planned','visited')),
  visited_at      timestamptz,
  notes           text,
  image_url       text,
  -- set null on user deletion: a NO ACTION FK here makes deleting any account
  -- that ever added a place to someone else's trip fail outright.
  added_by        uuid references auth.users(id) on delete set null,
  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Named rather than written inline on the column above. An inline check is
  -- auto-named places_kind_check, while the migration that introduced this
  -- column created places_kind_valid and guards on that name — so a project
  -- built from this file and then replayed through supabase/migrations/ picked
  -- up a second, redundant copy of the same check, and a rejected value
  -- reported a different constraint name than production does.
  constraint places_kind_valid check (kind in ('stop','spot')),
  -- A visited place must carry its visit time — the GeoJSON export filters on
  -- both and orders by visited_at, so a desynced row would silently vanish.
  constraint places_visited_at_coherent check (status <> 'visited' or visited_at is not null),
  constraint places_coords_bounded check (latitude between -90 and 90 and longitude between -180 and 180)
);

-- Target of trip_notes' composite (place_id, trip_id) foreign key, which is
-- what stops a note being attached to a place in a different trip. Declared
-- here because that FK is created further down and needs this to already exist.
alter table public.places add constraint places_id_trip_unique unique (id, trip_id);

-- A place's parent must be in the same trip. Declared here rather than inline
-- because it references the unique constraint just above. MATCH SIMPLE means a
-- null parent skips the check, which is what an unanchored place needs.
-- The column list on SET NULL is not optional: a bare `on delete set null` on
-- a composite key nulls every referencing column, so deleting a parent would
-- try to null the child's trip_id too and fail its not-null constraint —
-- making a city with anything anchored to it undeletable. Requires PG 15+.
alter table public.places
  add constraint places_parent_in_trip
  foreign key (parent_place_id, trip_id)
  references public.places(id, trip_id)
  on delete set null (parent_place_id);

-- A place cannot be inside itself. Longer cycles can't be expressed as a
-- check; the client renders one level only and treats a place whose parent
-- itself has a parent as top-level, so a cycle shows as two unnested headings
-- rather than as places that disappear.
alter table public.places
  add constraint places_parent_not_self
  check (parent_place_id is null or parent_place_id <> id);

-- Only a spot sits inside something — the half of the stop/spot model
-- a check constraint can see, and the important half: it guarantees stops are
-- always top level. That a parent is itself a stop is enforced by the client
-- (only stops are offered) and degraded gracefully by groupPlaces, which
-- ignores a parent that is not one.
alter table public.places
  add constraint places_anchored_is_spot
  check (parent_place_id is null or kind = 'spot');

create index places_kind_idx on public.places(trip_id, kind);

create index places_parent_idx
  on public.places(parent_place_id) where parent_place_id is not null;

-- The half of the stop/spot model a CHECK constraint cannot see.
--
-- A check can only read the row being written, so three rules were left to the
-- client: that a parent is itself a stop, that a parent is not itself anchored,
-- and that a place holding spots cannot move inside one. Every one of those
-- reads the writer's local snapshot of the trip, which is exactly what two
-- collaborators do not share.
--
-- Concretely: A files X inside Y while B, whose realtime channel has not yet
-- delivered A's write, files Y inside X. Both snapshots say the other place is
-- an unanchored stop with nothing in it, so both guards pass and both writes
-- satisfy places_anchored_is_spot. The result is a cycle that no screen can
-- show and almost no gesture can undo — groupPlaces refuses to nest either one
-- so both render as ordinary top-level rows, while the detail sheet disables
-- its picker on both and every plain reorder of them is silently discarded.
--
-- Requiring a parent to be a TOP-LEVEL stop is what closes it, and it closes
-- more than the cycle: if every parent is a root, the tree is at most one level
-- deep by construction, so no chain of any length can form and the "one level
-- only" rule the client renders is now also true in the database.

create or replace function public.places_enforce_hierarchy()
returns trigger language plpgsql
set search_path = public
as $$
begin
  if new.parent_place_id is not null then
    -- Same trip is already guaranteed by places_parent_in_trip; this is about
    -- what the parent IS. A locked read, because the row being pointed at can
    -- be changing in a concurrent transaction — an unlocked check would let
    -- two sessions each validate against a parent the other is demoting.
    if not exists (
      select 1 from public.places p
      where p.id = new.parent_place_id
        and p.kind = 'stop'
        and p.parent_place_id is null
      for share
    ) then
      raise exception 'A place can only sit inside a top-level stop'
        using errcode = 'check_violation';
    end if;
  end if;

  -- Nothing with places inside it may itself go inside something, in either
  -- direction it can be expressed: gaining a parent, or being demoted to a
  -- spot. Both would orphan whatever it holds, since only a stop can be
  -- a parent.
  if (new.parent_place_id is not null or new.kind = 'spot')
     and exists (select 1 from public.places c where c.parent_place_id = new.id) then
    raise exception 'Move the places inside this one out first'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- Scoped to the two columns that can break the rule, so ordinary edits — a
-- rename, a photo, marking somewhere visited, a reorder — do not pay for a
-- lookup they cannot invalidate.
--
-- This also fires for the FK's own `on delete set null (parent_place_id)`
-- write, which is fine: that write clears the pointer, and clearing is always
-- legal.
create trigger places_hierarchy_guard
  before insert or update of kind, parent_place_id on public.places
  for each row execute function public.places_enforce_hierarchy();


create table public.place_tags (
  place_id uuid not null references public.places(id) on delete cascade,
  tag_id   uuid not null references public.tags(id) on delete cascade,
  primary key (place_id, tag_id)
);

create table public.place_images (
  id         uuid primary key default uuid_generate_v4(),
  place_id   uuid not null references public.places(id) on delete cascade,
  url        text not null,
  caption    text,
  position   integer not null default 0,
  created_at timestamptz not null default now()
);

-- When you are somewhere, and for how long.
--
-- Its own table rather than columns on `places`, because a place can be
-- visited more than once: a loop drive comes back through the town it started
-- in, and a trip often opens and closes in the same city. Dates on the place
-- itself can only describe one of those and would overwrite the other.
--
-- Only stops carry dates. A spot is somewhere inside a stop, and it is the
-- stop you arrive at and leave; the spots under it inherit that window by
-- sitting there. The trigger further down enforces it, since a check cannot
-- read another row.
--
-- Deliberately separate from status/visited_at, which stay as they are: these
-- dates are the PLAN, `visited` is what happened.
create table public.place_visits (
  id         uuid primary key default uuid_generate_v4(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  place_id   uuid not null,
  -- A date, not a timestamp: nobody plans to the minute, and "8 November in
  -- Bangkok" means the same thing wherever it was booked from.
  starts_on  date not null,
  -- Null is a single day, not an open-ended stay — an unbounded visit has no
  -- length to draw and no way to be wrong about.
  ends_on    date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint place_visits_dates_ordered check (ends_on is null or ends_on >= starts_on)
);

-- Same shape as places_parent_in_trip: the composite key is what stops a visit
-- pointing at a place in another trip and being read through this trip's RLS.
alter table public.place_visits
  add constraint place_visits_place_in_trip
  foreign key (place_id, trip_id)
  references public.places(id, trip_id)
  on delete cascade;

create index place_visits_trip_idx on public.place_visits(trip_id, starts_on);
create index place_visits_place_idx on public.place_visits(place_id);

-- Only a stop can be arrived at. A check cannot read another row, so this is
-- the same trigger shape as the hierarchy guard above.
create or replace function public.place_visits_require_stop()
returns trigger language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.places p
    where p.id = new.place_id and p.kind = 'stop'
    for share
  ) then
    raise exception 'Only a stop can have dates'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger place_visits_stop_guard
  before insert or update of place_id on public.place_visits
  for each row execute function public.place_visits_require_stop();

-- And the other direction: demoting a dated stop to a spot would strand its
-- visits. Refused rather than cascaded — silently deleting somebody's dates is
-- not a decision this should make on its own.
create or replace function public.places_keep_dated_stops()
returns trigger language plpgsql
set search_path = public
as $$
begin
  if new.kind = 'spot' and old.kind = 'stop'
     and exists (select 1 from public.place_visits v where v.place_id = new.id) then
    raise exception 'Remove this place''s dates before making it a spot'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger places_dated_stop_guard
  before update of kind on public.places
  for each row execute function public.places_keep_dated_stops();


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

create trigger place_visits_updated_at before update on public.place_visits
  for each row execute function public.set_updated_at();

-- ============================================================
-- AUTO-ADD OWNER AS MEMBER
-- ============================================================

create or replace function public.add_trip_owner_as_member()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.trip_members (trip_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end;
$$;

create trigger trip_created after insert on public.trips
  for each row execute function public.add_trip_owner_as_member();

-- ============================================================
-- HELPERS
-- ============================================================

-- Defined first: can_read_place and can_write_place below call it, and this
-- file is meant to be run top to bottom on a fresh project. It used to sit
-- after them, which Postgres accepts for a plpgsql body but not for a SQL one
-- — a SQL function is parsed and its calls resolved at creation time, so
-- can_read_place failed with "function public.auth_uid() does not exist" and
-- the run stopped there, roughly a third of the way in. Every table existed
-- and most policies did not, which is the worst place for it to stop: not
-- obviously broken, just missing its access rules.
-- Modern PostgreSQL restricts non-superuser roles from reading the custom GUC
-- parameters PostgREST sets (request.jwt.*). Inline the JWT parse inside a
-- SECURITY DEFINER function so it runs as postgres, which can read them.
create or replace function public.auth_uid()
returns uuid language sql security definer stable
set search_path = extensions, public, auth
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::json->>'sub'
  )::uuid
$$;

grant execute on function public.auth_uid() to anon, authenticated;

create or replace function public.is_trip_member(trip uuid, usr uuid)
returns boolean language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public.trip_members
    where trip_id = trip and user_id = usr
  );
$$;

-- Writes require owner or editor; viewers are genuinely read-only.
create or replace function public.is_trip_editor(trip uuid, usr uuid)
returns boolean language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public.trip_members
    where trip_id = trip and user_id = usr and role in ('owner', 'editor')
  );
$$;

-- Membership via a place's parent trip. place_tags, place_images and
-- place_comments all gate on "can I see/edit the trip this place belongs to?",
-- which was the same exists(...) subquery copy-pasted eight times.
create or replace function public.can_read_place(place uuid)
returns boolean language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public.places p
    where p.id = place and public.is_trip_member(p.trip_id, public.auth_uid())
  );
$$;

create or replace function public.can_write_place(place uuid)
returns boolean language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public.places p
    where p.id = place and public.is_trip_editor(p.trip_id, public.auth_uid())
  );
$$;

-- SECURITY DEFINER RPC for trip creation — bypasses RLS INSERT evaluation
-- entirely. auth.uid() runs in SECURITY DEFINER context where request.jwt.claims
-- is readable, avoiding the same GUC restriction auth_uid() works around above.
-- Every trip is created through here; the client never INSERTs into trips.
create or replace function public.create_trip(
  p_name        text,
  p_description text default null,
  p_start_date  date default null,
  p_end_date    date default null
)
returns public.trips
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid  uuid;
  v_trip public.trips;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  insert into public.trips (name, description, start_date, end_date, owner_id)
  values (p_name, p_description, p_start_date, p_end_date, v_uid)
  returning * into v_trip;
  return v_trip;
end;
$$;

grant execute on function public.create_trip(text, text, date, date) to authenticated;

-- ============================================================
-- RLS
-- ============================================================

alter table public.trips enable row level security;
alter table public.trip_members enable row level security;
alter table public.tags enable row level security;
alter table public.places enable row level security;
alter table public.place_tags enable row level security;
alter table public.place_images enable row level security;
alter table public.place_visits enable row level security;

-- trips
-- owner_id is checked before membership so a freshly created trip is readable
-- in the same statement that creates it, before the after-insert trigger has
-- added the owner to trip_members. Anonymous share access is NOT handled here
-- — it goes through the token-scoped get_shared_trip RPC below.
create policy "trip_select" on public.trips for select
  using (
    owner_id = public.auth_uid()
    or public.is_trip_member(id, public.auth_uid())
  );

create policy "trip_insert" on public.trips for insert
  with check (owner_id = public.auth_uid());

create policy "trip_update" on public.trips for update
  using (public.is_trip_editor(id, public.auth_uid()))
  with check (public.is_trip_editor(id, public.auth_uid()));

-- Editors may change trip *content* only. owner_id and share_token sit outside
-- this column grant, so a PATCH touching them is rejected outright — without
-- this, an editor could seize ownership by writing owner_id. (updated_at is
-- written by a trigger, which column grants don't constrain.)
revoke update on table public.trips from anon, authenticated;
grant update (name, description, notes, start_date, end_date, cover_image_url)
  on public.trips to authenticated;

-- share_token is likewise excluded from SELECT: it's a bearer credential for
-- the public /shared view, and a viewer-role member must not be able to lift
-- it and publish a trip the owner never shared. The owner reads/rotates it via
-- the RPCs below. Client-side selects must therefore name their columns —
-- select('*') on trips fails with a column permission error by design.
revoke select on table public.trips from anon, authenticated;
grant select (id, name, description, notes, start_date, end_date, cover_image_url,
              owner_id, created_at, updated_at)
  on public.trips to authenticated;

-- Owner-only read of the share token (drives the "copy share link" UI).
create or replace function public.get_share_token(p_trip_id uuid)
returns uuid
language sql security definer stable
set search_path = public, auth
as $$
  select t.share_token from public.trips t
  where t.id = p_trip_id and t.owner_id = auth.uid();
$$;

grant execute on function public.get_share_token(uuid) to authenticated;

-- Rotate the token: the owner's remedy when a share link leaked. Old links
-- (including geojson exports) stop working immediately.
create or replace function public.rotate_share_token(p_trip_id uuid)
returns uuid
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_token uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  -- gen_random_uuid(), not uuid_generate_v4(): the latter lives in the
  -- extensions schema, which this function's pinned search_path can't see.
  update public.trips
    set share_token = gen_random_uuid()
  where id = p_trip_id and owner_id = auth.uid()
  returning share_token into v_token;
  if v_token is null then
    raise exception 'Only the trip owner can reset the share link';
  end if;
  return v_token;
end;
$$;

grant execute on function public.rotate_share_token(uuid) to authenticated;

create policy "trip_delete" on public.trips for delete
  using (owner_id = public.auth_uid());

-- trip_members
create policy "tm_select" on public.trip_members for select
  using (public.is_trip_member(trip_id, public.auth_uid()));

create policy "tm_insert" on public.trip_members for insert
  with check (
    exists (
      select 1 from public.trips t
      where t.id = trip_id and t.owner_id = public.auth_uid()
    )
  );

create policy "tm_delete" on public.trip_members for delete
  using (
    user_id = public.auth_uid()
    or exists (
      select 1 from public.trips t
      where t.id = trip_id and t.owner_id = public.auth_uid()
    )
  );

-- tags
create policy "tags_select" on public.tags for select
  using (public.is_trip_member(trip_id, public.auth_uid()));
create policy "tags_insert" on public.tags for insert
  with check (public.is_trip_editor(trip_id, public.auth_uid()));
create policy "tags_update" on public.tags for update
  using (public.is_trip_editor(trip_id, public.auth_uid()));
create policy "tags_delete" on public.tags for delete
  using (public.is_trip_editor(trip_id, public.auth_uid()));

-- Atomic reorder: one statement for the whole new order. The client used to
-- issue one UPDATE per place, and a partial failure left server, client, and
-- realtime three different orders.
create or replace function public.reorder_places(p_trip_id uuid, p_place_ids uuid[])
returns void
language plpgsql security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.is_trip_editor(p_trip_id, auth.uid()) then
    raise exception 'Not an editor of this trip';
  end if;
  update public.places p
    set position = u.ord - 1
  from unnest(p_place_ids) with ordinality as u(id, ord)
  where p.id = u.id and p.trip_id = p_trip_id;
end;
$$;

grant execute on function public.reorder_places(uuid, uuid[]) to authenticated;

-- places
create policy "places_select" on public.places for select
  using (public.is_trip_member(trip_id, public.auth_uid()));
-- added_by must be the caller (or null): without the check, an editor could
-- attribute a place — and its activity-feed entry — to any other member.
create policy "places_insert" on public.places for insert
  with check (
    public.is_trip_editor(trip_id, public.auth_uid())
    and (added_by is null or added_by = public.auth_uid())
  );
create policy "places_update" on public.places for update
  using (public.is_trip_editor(trip_id, public.auth_uid()));
create policy "places_delete" on public.places for delete
  using (public.is_trip_editor(trip_id, public.auth_uid()));

-- place_tags
create policy "place_tags_select" on public.place_tags for select
  using (
    public.can_read_place(place_id)
  );
create policy "place_tags_insert" on public.place_tags for insert
  with check (
    public.can_write_place(place_id)
  );
create policy "place_tags_delete" on public.place_tags for delete
  using (
    public.can_write_place(place_id)
  );

-- place_images (rows; the stored files are covered in the STORAGE section)
create policy "place_images_select" on public.place_images for select
  using (
    public.can_read_place(place_id)
  );
create policy "place_images_insert" on public.place_images for insert
  with check (
    public.can_write_place(place_id)
  );
create policy "place_images_delete" on public.place_images for delete
  using (
    public.can_write_place(place_id)
  );

-- place_visits — scoped by trip rather than by place, because the row carries
-- trip_id itself and the composite FK guarantees the two agree.
create policy "place_visits_select" on public.place_visits for select
  using (public.is_trip_member(trip_id, public.auth_uid()));
create policy "place_visits_insert" on public.place_visits for insert
  with check (public.is_trip_editor(trip_id, public.auth_uid()));
create policy "place_visits_update" on public.place_visits for update
  using (public.is_trip_editor(trip_id, public.auth_uid()));
create policy "place_visits_delete" on public.place_visits for delete
  using (public.is_trip_editor(trip_id, public.auth_uid()));

-- ============================================================
-- COLLABORATION RPCs
-- ============================================================

-- Returns trip members with their email (reads auth.users via SECURITY DEFINER)
create or replace function public.get_trip_members(p_trip_id uuid)
returns table (
  id        uuid,
  trip_id   uuid,
  user_id   uuid,
  role      text,
  joined_at timestamptz,
  email     text
)
language sql security definer stable
set search_path = public, auth
as $$
  select
    tm.id,
    tm.trip_id,
    tm.user_id,
    tm.role,
    tm.joined_at,
    u.email
  from public.trip_members tm
  join auth.users u on u.id = tm.user_id
  where tm.trip_id = p_trip_id
    and public.is_trip_member(p_trip_id, auth.uid())
  order by
    case tm.role when 'owner' then 0 else 1 end,
    tm.joined_at
$$;

grant execute on function public.get_trip_members(uuid) to authenticated;

-- Remove a collaborator (owner only, cannot remove owner)
create or replace function public.remove_collaborator(
  p_trip_id uuid,
  p_user_id uuid
)
returns void
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'Not authenticated'; end if;

  if not exists (
    select 1 from public.trips where id = p_trip_id and owner_id = v_uid
  ) then
    raise exception 'Only the trip owner can remove collaborators';
  end if;

  if exists (select 1 from public.trips where id = p_trip_id and owner_id = p_user_id) then
    raise exception 'Cannot remove the trip owner';
  end if;

  delete from public.trip_members where trip_id = p_trip_id and user_id = p_user_id;
end;
$$;

grant execute on function public.remove_collaborator(uuid, uuid) to authenticated;

-- ============================================================
-- TRIP INVITES — pending memberships via a copyable link
-- ------------------------------------------------------------
-- Every invite is a token link, whether or not the email already has an
-- account: the owner shares the link, and whoever opens it and signs in
-- redeems the token (acceptance is by token; email is just a label of who it
-- was meant for). Uniform tokens keep two problems out: the RPC's response
-- can't be used to probe which emails have accounts on the instance, and
-- nobody is ever added to a trip without opening the link themselves.
-- ============================================================

create table public.trip_invites (
  id          uuid primary key default uuid_generate_v4(),
  trip_id     uuid not null references public.trips(id) on delete cascade,
  email       text,
  role        text not null default 'editor' check (role in ('editor', 'viewer')),
  token       uuid not null unique default uuid_generate_v4(),
  invited_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  expires_at  timestamptz not null default (now() + interval '30 days')
);
create index trip_invites_trip_id_idx on public.trip_invites(trip_id);

alter table public.trip_invites enable row level security;

-- Tokens are bearer credentials: only the owner (who hands the link out) may
-- read them — a viewer-role member must not be able to lift a pending editor
-- token and pass it to an outsider. All writes go through the SECURITY
-- DEFINER RPCs below; the accept screen's token lookup is its own RPC.
create policy "trip_invites_select" on public.trip_invites for select
  using (
    exists (select 1 from public.trips t
      where t.id = trip_id and t.owner_id = public.auth_uid())
  );

-- Create an invite: always a pending token link (reusing an open one for the
-- same email if present), never an immediate membership — see block comment.
create or replace function public.create_trip_invite(
  p_trip_id uuid,
  p_email   text,
  p_role    text default 'editor'
)
returns jsonb
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_uid    uuid;
  v_token  uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_role not in ('editor', 'viewer') then
    raise exception 'Role must be editor or viewer';
  end if;
  if not exists (
    select 1 from public.trips t where t.id = p_trip_id and t.owner_id = v_uid
  ) then
    raise exception 'Only the trip owner can invite collaborators';
  end if;

  select token into v_token
  from public.trip_invites
  where trip_id = p_trip_id and lower(email) = lower(p_email)
    and accepted_at is null and expires_at > now()
  limit 1;

  if v_token is null then
    insert into public.trip_invites (trip_id, email, role, invited_by)
    values (p_trip_id, p_email, p_role, v_uid)
    returning token into v_token;
  else
    update public.trip_invites set role = p_role where token = v_token;
  end if;

  return jsonb_build_object('status', 'invited', 'email', p_email, 'role', p_role, 'token', v_token);
end;
$$;

grant execute on function public.create_trip_invite(uuid, text, text) to authenticated;

-- Public token lookup for the accept screen (name/role/inviter, no row
-- access). Only live invites answer: an expired or already-redeemed token
-- must not keep leaking the trip name and inviter email to whoever replays
-- the old link.
create or replace function public.get_trip_invite(p_token uuid)
returns table (
  trip_id       uuid,
  trip_name     text,
  role          text,
  inviter_email text,
  accepted      boolean
)
language sql security definer stable
set search_path = public, auth
as $$
  select i.trip_id, t.name, i.role, u.email, (i.accepted_at is not null)
  from public.trip_invites i
  join public.trips t on t.id = i.trip_id
  join auth.users u on u.id = i.invited_by
  where i.token = p_token
    and i.accepted_at is null
    and i.expires_at > now();
$$;

grant execute on function public.get_trip_invite(uuid) to anon, authenticated;

-- Redeem an invite for the signed-in user; idempotent if already a member.
create or replace function public.accept_trip_invite(p_token uuid)
returns uuid
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
  v_inv public.trip_invites;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_inv from public.trip_invites where token = p_token;
  if not found then raise exception 'Invite not found'; end if;

  if exists (
    select 1 from public.trip_members where trip_id = v_inv.trip_id and user_id = v_uid
  ) then
    return v_inv.trip_id;
  end if;

  if v_inv.accepted_at is not null then
    raise exception 'This invite has already been used';
  end if;

  if v_inv.expires_at < now() then
    raise exception 'This invite has expired';
  end if;

  insert into public.trip_members (trip_id, user_id, role)
  values (v_inv.trip_id, v_uid, v_inv.role)
  on conflict (trip_id, user_id) do nothing;

  update public.trip_invites
    set accepted_at = now(), accepted_by = v_uid
  where token = p_token;

  return v_inv.trip_id;
end;
$$;

grant execute on function public.accept_trip_invite(uuid) to authenticated;

-- Revoke a pending invite (owner only).
create or replace function public.revoke_trip_invite(p_token uuid)
returns void
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'Not authenticated'; end if;
  delete from public.trip_invites i
  using public.trips t
  where i.token = p_token and t.id = i.trip_id and t.owner_id = v_uid;
end;
$$;

grant execute on function public.revoke_trip_invite(uuid) to authenticated;

-- ============================================================
-- TRIP NOTES (bullets)
-- ------------------------------------------------------------
-- Notes are rows, not a text blob on trips/places. A single text value is
-- last-write-wins, so two members editing notes at once meant one of them
-- silently lost their edit. A row per bullet syncs independently over
-- realtime, exactly like places do.
--
-- One table serves both scopes: place_id null is a note about the whole trip,
-- place_id set is a bullet on that place.
-- ============================================================

create table public.trip_notes (
  id         uuid primary key default uuid_generate_v4(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  place_id   uuid,
  body       text not null,
  position   int  not null default 0,
  -- Nesting level. The outline is a flat ordered list plus a depth, not a
  -- parent_id tree: the tree is implied by the order (an item's parent is the
  -- nearest item above it with a smaller depth), which keeps one atomic
  -- reorder RPC, one realtime row per bullet, and no way to orphan a row by
  -- deleting its parent. The client clamps an impossible depth on render.
  depth      int  not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An empty bullet is a UI state, never a stored row.
  constraint trip_notes_body_not_blank check (length(btrim(body)) > 0),

  -- A ceiling rather than unlimited nesting: each level costs horizontal
  -- space, and past this a bullet on a 390px phone has more indent than text.
  constraint trip_notes_depth_bounded check (depth between 0 and 5),

  -- A note's place must belong to the note's trip. MATCH SIMPLE means a null
  -- place_id skips the check, which is exactly right for trip-wide notes — and
  -- it keeps trip_id trustworthy, which every policy below depends on.
  constraint trip_notes_place_in_trip
    foreign key (place_id, trip_id)
    references public.places(id, trip_id) on delete cascade
);

create index trip_notes_lookup_idx
  on public.trip_notes(trip_id, place_id, position);

create trigger trip_notes_updated_at before update on public.trip_notes
  for each row execute function public.set_updated_at();

alter table public.trip_notes enable row level security;

create policy "trip_notes_select" on public.trip_notes for select
  using (public.is_trip_member(trip_id, public.auth_uid()));

-- created_by must be the caller (or null), for the same reason places.added_by
-- is constrained: otherwise an editor could attribute a note to another member.
create policy "trip_notes_insert" on public.trip_notes for insert
  with check (
    public.is_trip_editor(trip_id, public.auth_uid())
    and (created_by is null or created_by = public.auth_uid())
  );

create policy "trip_notes_update" on public.trip_notes for update
  using (public.is_trip_editor(trip_id, public.auth_uid()));

create policy "trip_notes_delete" on public.trip_notes for delete
  using (public.is_trip_editor(trip_id, public.auth_uid()));

alter table public.trip_notes replica identity full;
alter publication supabase_realtime add table public.trip_notes;
alter table public.place_visits replica identity full;
alter publication supabase_realtime add table public.place_visits;

-- Whole order written atomically, like reorder_places: per-row updates could
-- partially fail and leave server, client and realtime disagreeing.
create or replace function public.reorder_trip_notes(p_trip_id uuid, p_note_ids uuid[])
returns void
language plpgsql security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.is_trip_editor(p_trip_id, auth.uid()) then
    raise exception 'Not an editor of this trip';
  end if;
  update public.trip_notes n
    set position = u.ord - 1
  from unnest(p_note_ids) with ordinality as u(id, ord)
  where n.id = u.id and n.trip_id = p_trip_id;
end;
$$;

grant execute on function public.reorder_trip_notes(uuid, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- Depth — same shape and same reason as reorder above: one atomic write, so a
-- subtree spanning several levels cannot half-apply and leave the client, the
-- server and realtime disagreeing about the outline's shape.
-- ------------------------------------------------------------
create or replace function public.set_trip_note_depths(
  p_trip_id uuid,
  p_note_ids uuid[],
  p_depths int[]
)
returns void
language plpgsql security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.is_trip_editor(p_trip_id, auth.uid()) then
    raise exception 'Not an editor of this trip';
  end if;
  if array_length(p_note_ids, 1) is distinct from array_length(p_depths, 1) then
    raise exception 'Mismatched ids and depths';
  end if;

  -- Scoped to the trip as well as the ids, so a caller cannot reach a bullet
  -- in a trip they are not an editor of by passing its id.
  update public.trip_notes n
     set depth = u.depth
    from unnest(p_note_ids, p_depths) as u(id, depth)
   where n.id = u.id and n.trip_id = p_trip_id;
end;
$$;

grant execute on function public.set_trip_note_depths(uuid, uuid[], int[]) to authenticated;

-- ============================================================
-- READ-ONLY TRIP SHARING (token-scoped RPC)
-- ------------------------------------------------------------
-- /shared/:token renders from this single anon-callable RPC — the same trust
-- model as invite links: possession of the (uuid) token is the authorization.
-- Direct table reads can't serve anonymous visitors, who fail every
-- membership-based RLS policy.
-- ============================================================

create or replace function public.get_shared_trip(p_token uuid)
returns jsonb
language sql security definer stable
set search_path = public
as $$
  select jsonb_build_object(
    -- Denylist, so every column added to `trips` is published here unless it
    -- is named. `notes` is the trip's private scratchpad (door codes, booking
    -- references) and must never reach an anonymous token holder.
    'trip', to_jsonb(t) - 'share_token' - 'owner_id' - 'notes',
    'tags', coalesce(
      (select jsonb_agg(to_jsonb(tg)) from public.tags tg where tg.trip_id = t.id),
      '[]'::jsonb),
    'places', coalesce((
      select jsonb_agg(
        -- scrub like the trip object: anonymous token holders get the trip
        -- content, not live auth.users UUIDs or Google internals.
        (to_jsonb(p) - 'added_by' - 'google_place_id' - 'notes') || jsonb_build_object(
          'tags', coalesce(
            (select jsonb_agg(to_jsonb(tg2))
             from public.place_tags pt
             join public.tags tg2 on tg2.id = pt.tag_id
             where pt.place_id = p.id),
            '[]'::jsonb),
          'images', coalesce(
            (select jsonb_agg(to_jsonb(pi) order by pi.position)
             from public.place_images pi where pi.place_id = p.id),
            '[]'::jsonb),
          -- Scoped to this place, so a trip-wide note (place_id is null) can
          -- never be swept in here.
          'note_items', coalesce(
            (select jsonb_agg(
               jsonb_build_object(
                 'id', n.id, 'body', n.body, 'position', n.position, 'depth', n.depth)
               order by n.position, n.created_at)
             from public.trip_notes n where n.place_id = p.id),
            '[]'::jsonb)
        )
        order by p.position
      )
      from public.places p where p.trip_id = t.id
    ), '[]'::jsonb)
  )
  from public.trips t
  where t.share_token = p_token;
$$;

grant execute on function public.get_shared_trip(uuid) to anon, authenticated;

-- ============================================================
-- INDEXES
-- ============================================================

create index trips_owner_id_idx on public.trips(owner_id);
create index trip_members_user_id_idx on public.trip_members(user_id);
create index tags_trip_id_idx on public.tags(trip_id);
-- The frontend's hot paths: place loads filter trip_id + order by position,
-- every place fetch embeds place_images, tag deletion cascades by tag_id.
-- (activity's cascade indexes live next to the activity table below — this
-- file must stay runnable top-to-bottom in a single SQL Editor paste.)
create index places_trip_position_idx on public.places(trip_id, position);
create index place_images_place_id_idx on public.place_images(place_id);
create index place_tags_tag_id_idx on public.place_tags(tag_id);

-- ============================================================
-- STORAGE
-- ------------------------------------------------------------
-- One public bucket for all app images (place photos + trip covers). Files
-- live under {trip_id}/... so the policies can gate writes on membership via
-- the first path segment. "Public" means anyone with a file's URL can fetch
-- its bytes; listing/writing still goes through these policies.
-- ============================================================
-- MIME + size limits matter on a public bucket: without them any editor can
-- upload text/html and get it served from your *.supabase.co origin
-- (phishing / stored XSS), or fill the bucket with arbitrarily large files.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('place-images', 'place-images', true, 10485760, array['image/*'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "place_images_select" on storage.objects for select
  using (
    bucket_id = 'place-images'
    and public.is_trip_member(((storage.foldername(name))[1])::uuid, public.auth_uid())
  );
create policy "place_images_insert" on storage.objects for insert
  with check (
    bucket_id = 'place-images'
    and public.is_trip_editor(((storage.foldername(name))[1])::uuid, public.auth_uid())
  );
create policy "place_images_delete" on storage.objects for delete
  using (
    bucket_id = 'place-images'
    and public.is_trip_editor(((storage.foldername(name))[1])::uuid, public.auth_uid())
  );

-- ============================================================
-- REALTIME
-- ------------------------------------------------------------
-- usePlaces/useTags subscribe to postgres_changes on these tables; without
-- this the channels connect and simply never fire (collaborators never see
-- each other's edits live). replica identity full so DELETE events carry the
-- trip_id the client-side filter needs. place_tags/place_images are published
-- too: tag and photo edits touch only the join tables, and without events for
-- them collaborators keep stale tags/galleries until an unrelated place edit.
-- ============================================================
alter table public.places replica identity full;
alter table public.tags replica identity full;
alter table public.place_tags replica identity full;
alter table public.place_images replica identity full;
alter publication supabase_realtime add table
  public.places, public.tags, public.place_tags, public.place_images;

-- ============================================================
-- PLACE COMMENTS
-- ------------------------------------------------------------
-- A per-place discussion thread so collaborators can talk through a spot
-- ("should we book this?") separately from the single-author notes field.
-- Any trip member may read and post; you may only delete your own comment
-- (the trip owner may delete any, to moderate).
-- ============================================================

create table public.place_comments (
  id         uuid primary key default uuid_generate_v4(),
  place_id   uuid not null references public.places(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index place_comments_place_id_idx on public.place_comments(place_id, created_at);

alter table public.place_comments enable row level security;

-- Membership is checked through the parent place's trip, mirroring places/tags.
create policy "place_comments_select" on public.place_comments for select
  using (
    public.can_read_place(place_id)
  );

create policy "place_comments_insert" on public.place_comments for insert
  with check (
    user_id = public.auth_uid()
    and public.can_read_place(place_id)
  );

-- Author can delete their own; trip owner can delete anyone's (moderation).
create policy "place_comments_delete" on public.place_comments for delete
  using (
    user_id = public.auth_uid()
    or exists (
      select 1 from public.places p
      join public.trips t on t.id = p.trip_id
      where p.id = place_id and t.owner_id = public.auth_uid()
    )
  );

-- Returns a place's comments with each author's email (reads auth.users via
-- SECURITY DEFINER, same pattern as get_trip_members).
create or replace function public.get_place_comments(p_place_id uuid)
returns table (
  id         uuid,
  place_id   uuid,
  user_id    uuid,
  email      text,
  body       text,
  created_at timestamptz
)
language sql security definer stable
set search_path = public, auth
as $$
  select c.id, c.place_id, c.user_id, u.email, c.body, c.created_at
  from public.place_comments c
  join auth.users u on u.id = c.user_id
  join public.places p on p.id = c.place_id
  where c.place_id = p_place_id
    and public.is_trip_member(p.trip_id, auth.uid())
  order by c.created_at;
$$;

grant execute on function public.get_place_comments(uuid) to authenticated;

-- Inserts a comment as the caller and returns it with the author email joined,
-- so the client can append it to the thread without a second round-trip.
create or replace function public.add_place_comment(
  p_place_id uuid,
  p_body     text
)
returns table (
  id         uuid,
  place_id   uuid,
  user_id    uuid,
  email      text,
  body       text,
  created_at timestamptz
)
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
  v_id  uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'Not authenticated'; end if;

  if not exists (
    select 1 from public.places p
    where p.id = p_place_id and public.is_trip_member(p.trip_id, v_uid)
  ) then
    raise exception 'Not a member of this trip';
  end if;

  insert into public.place_comments (place_id, user_id, body)
  values (p_place_id, v_uid, p_body)
  returning place_comments.id into v_id;

  return query
    -- ::text matters: auth.users.email is varchar(255), and plpgsql's RETURN
    -- QUERY (unlike LANGUAGE sql) refuses the implicit coercion — without the
    -- cast every comment post fails with "structure of query does not match".
    select c.id, c.place_id, c.user_id, u.email::text, c.body, c.created_at
    from public.place_comments c
    join auth.users u on u.id = c.user_id
    where c.id = v_id;
end;
$$;

grant execute on function public.add_place_comment(uuid, text) to authenticated;

-- ============================================================
-- ACTIVITY FEED
-- ------------------------------------------------------------
-- Powers the in-app notification bell: a row is recorded whenever someone adds
-- a place or posts a comment, and each user sees activity from every trip they
-- belong to (except their own actions).
--
-- An item leaves a user's inbox if EITHER it predates their "mark all read"
-- cursor (activity_seen) OR it was individually dismissed (activity_dismissed)
-- — by tapping through to its place or swiping it away, which are the same
-- action. The feed itself is never cleared — it's a rolling window
-- (get_activity returns the newest 50); dismissed items simply drop out.
-- ============================================================

create table public.activity (
  id         uuid primary key default uuid_generate_v4(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  actor_id   uuid not null references auth.users(id) on delete cascade,
  type       text not null check (type in ('place_added', 'comment_added')),
  place_id   uuid references public.places(id) on delete cascade,
  comment_id uuid references public.place_comments(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index activity_trip_id_idx on public.activity(trip_id, created_at desc);
-- Cascade hot paths: place/comment deletion walks activity through these FKs.
create index activity_place_id_idx on public.activity(place_id);
create index activity_comment_id_idx on public.activity(comment_id);

-- Per-user "mark all read" cursor: everything at or before this is read.
create table public.activity_seen (
  user_id uuid primary key references auth.users(id) on delete cascade,
  seen_at timestamptz not null default now()
);

-- Per-user, per-item dismissals — recorded whether the user tapped through to
-- the place or swiped the row away (one and the same action). Hides the item
-- from that user's feed; the shared activity row itself stays for other trip
-- members.
create table public.activity_dismissed (
  user_id      uuid not null references auth.users(id) on delete cascade,
  activity_id  uuid not null references public.activity(id) on delete cascade,
  dismissed_at timestamptz not null default now(),
  primary key (user_id, activity_id)
);

alter table public.activity enable row level security;
alter table public.activity_seen enable row level security;
alter table public.activity_dismissed enable row level security;

create policy "activity_dismissed_all" on public.activity_dismissed for all
  using (user_id = public.auth_uid())
  with check (user_id = public.auth_uid());

create policy "activity_select" on public.activity for select
  using (public.is_trip_member(trip_id, public.auth_uid()));

create policy "activity_seen_all" on public.activity_seen for all
  using (user_id = public.auth_uid())
  with check (user_id = public.auth_uid());

-- Record a row whenever a place is added… A logging trigger must never fail
-- the write it observes: when the actor can't be attributed (service-role
-- inserts, SQL editor, imports) skip the activity row instead of violating
-- activity.actor_id NOT NULL and rolling back the place insert itself.
create or replace function public.log_place_added()
returns trigger language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_actor uuid;
begin
  v_actor := coalesce(new.added_by, auth.uid());
  if v_actor is null then return new; end if;
  insert into public.activity (trip_id, actor_id, type, place_id)
  values (new.trip_id, v_actor, 'place_added', new.id);
  return new;
end;
$$;

create trigger place_added_activity after insert on public.places
  for each row execute function public.log_place_added();

-- …and whenever a comment is posted.
create or replace function public.log_comment_added()
returns trigger language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_trip uuid;
begin
  select trip_id into v_trip from public.places where id = new.place_id;
  insert into public.activity (trip_id, actor_id, type, place_id, comment_id)
  values (v_trip, new.user_id, 'comment_added', new.place_id, new.id);
  return new;
end;
$$;

create trigger comment_added_activity after insert on public.place_comments
  for each row execute function public.log_comment_added();

-- Inbox for the current user: active (not-yet-dismissed) activity across their
-- trips, other people's actions only, newest first, with author email +
-- place/trip names joined in. Dismissed items are filtered out entirely — the
-- feed only ever shows what still needs attention.
create or replace function public.get_activity()
returns table (
  id          uuid,
  type        text,
  actor_email text,
  trip_id     uuid,
  trip_name   text,
  place_id    uuid,
  place_name  text,
  snippet     text,
  created_at  timestamptz
)
language sql security definer stable
set search_path = public, auth
as $$
  select
    a.id,
    a.type,
    u.email,
    a.trip_id,
    t.name,
    a.place_id,
    p.name,
    c.body,
    a.created_at
  from public.activity a
  join auth.users u on u.id = a.actor_id
  join public.trips t on t.id = a.trip_id
  left join public.places p on p.id = a.place_id
  left join public.place_comments c on c.id = a.comment_id
  left join public.activity_seen s on s.user_id = auth.uid()
  left join public.activity_dismissed d on d.activity_id = a.id and d.user_id = auth.uid()
  where public.is_trip_member(a.trip_id, auth.uid())
    and a.actor_id <> auth.uid()
    and not coalesce(a.created_at <= s.seen_at, false)  -- not marked-all-read
    and d.activity_id is null                            -- not dismissed
  order by a.created_at desc
  limit 50;
$$;

grant execute on function public.get_activity() to authenticated;

-- Dismiss a single item for this user — tapping through to its place or
-- swiping it away, which are the same action.
create or replace function public.dismiss_activity(p_activity_id uuid)
returns void
language sql security definer
set search_path = public, auth
as $$
  insert into public.activity_dismissed (user_id, activity_id)
  values (auth.uid(), p_activity_id)
  on conflict (user_id, activity_id) do nothing;
$$;

grant execute on function public.dismiss_activity(uuid) to authenticated;

-- Mark everything up to now as seen — the "Mark all read" button.
create or replace function public.mark_activity_seen()
returns void
language sql security definer
set search_path = public, auth
as $$
  insert into public.activity_seen (user_id, seen_at)
  values (auth.uid(), now())
  on conflict (user_id) do update set seen_at = now();
$$;

grant execute on function public.mark_activity_seen() to authenticated;

-- ============================================================
-- FUNCTION PRIVILEGES — make the grants above real
-- ------------------------------------------------------------
-- Postgres grants EXECUTE on every new function to PUBLIC by default, so the
-- per-function `grant execute … to authenticated` statements above are not by
-- themselves access control: without this block anon could call any RPC, with
-- each function's own auth.uid()/membership check holding the line alone.
-- Strip the implicit
-- grant from this file's functions, then re-grant per role. Deliberately an
-- explicit list — `all functions in schema public` would also revoke
-- extension helpers like uuid_generate_v4(), and column defaults execute
-- with the *inserting role's* privileges, which would break every INSERT.
-- If you add a function to this file, add it here too.
-- ============================================================
revoke execute on function
  public.auth_uid(),
  public.is_trip_member(uuid, uuid),
  public.is_trip_editor(uuid, uuid),
  public.can_read_place(uuid),
  public.can_write_place(uuid),
  public.create_trip(text, text, date, date),
  public.get_trip_members(uuid),
  public.remove_collaborator(uuid, uuid),
  public.create_trip_invite(uuid, text, text),
  public.get_trip_invite(uuid),
  public.accept_trip_invite(uuid),
  public.revoke_trip_invite(uuid),
  public.get_shared_trip(uuid),
  public.get_share_token(uuid),
  public.rotate_share_token(uuid),
  public.reorder_places(uuid, uuid[]),
  public.get_place_comments(uuid),
  public.add_place_comment(uuid, text),
  public.get_activity(),
  public.dismiss_activity(uuid),
  public.mark_activity_seen(),
  public.set_updated_at(),
  public.add_trip_owner_as_member(),
  public.log_place_added(),
  public.log_comment_added()
from public, anon;

-- RLS and storage policies evaluate these as the calling role.
grant execute on function public.auth_uid() to anon, authenticated;
grant execute on function public.is_trip_member(uuid, uuid) to anon, authenticated;
grant execute on function public.is_trip_editor(uuid, uuid) to anon, authenticated;
grant execute on function public.can_read_place(uuid) to anon, authenticated;
grant execute on function public.can_write_place(uuid) to anon, authenticated;

-- The two genuinely anonymous entry points (share links + invite links).
grant execute on function public.get_shared_trip(uuid) to anon;
grant execute on function public.get_trip_invite(uuid) to anon;
