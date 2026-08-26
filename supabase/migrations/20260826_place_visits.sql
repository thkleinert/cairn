-- When you are somewhere, and for how long.
--
-- Its own table rather than columns on `places`, because a place can be
-- visited more than once: a loop drive comes back through the town it started
-- in, and a trip often opens and closes in the same city. A start and end date
-- on the place itself can only ever describe one of those, and would quietly
-- overwrite the other.
--
-- Only stops carry dates. A spot is somewhere inside a stop — a café, a
-- viewpoint — and it is the stop you arrive at and leave; the spots inside it
-- inherit that window by sitting under it. Giving a café its own arrival date
-- would invite two answers to the same question.
--
-- Deliberately separate from `status`/`visited_at`, which stay as they are.
-- These dates are the PLAN; `visited` is what actually happened. Merging them
-- would mean the map route and the GeoJSON export — both of which order by
-- visited_at — had to learn about repeat visits in the same change.

create table public.place_visits (
  id         uuid primary key default uuid_generate_v4(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  place_id   uuid not null,
  -- A date, not a timestamp. Nobody plans a trip to the minute, and a
  -- timestamp would drag time zones into a question that does not have them:
  -- "8 November in Bangkok" means the same thing wherever you booked it from.
  starts_on  date not null,
  -- Null means a single day rather than an open-ended stay: an unbounded visit
  -- has no length to draw and no way to be wrong about, so the timeline treats
  -- a missing end as "this one day".
  ends_on    date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint place_visits_dates_ordered check (ends_on is null or ends_on >= starts_on)
);

-- Place and visit must belong to the same trip. Same shape as
-- places_parent_in_trip, and for the same reason: without it a visit could
-- point at a place in somebody else's trip and be read through this trip's
-- RLS. Cascades, because a visit to a deleted place is not a visit.
alter table public.place_visits
  add constraint place_visits_place_in_trip
  foreign key (place_id, trip_id)
  references public.places(id, trip_id)
  on delete cascade;

create index place_visits_trip_idx on public.place_visits(trip_id, starts_on);
create index place_visits_place_idx on public.place_visits(place_id);

-- Only a stop can be arrived at, and a stop with dates cannot quietly become a
-- spot underneath them. A check constraint cannot see another row, so this is
-- the same trigger shape places_hierarchy_guard uses.
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

-- The other direction: demoting a dated stop to a spot would strand its
-- visits. Refused rather than cascaded, exactly as anchoring a place that
-- holds other places is refused — silently deleting somebody's dates is not a
-- decision this should make on its own.
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

create trigger place_visits_updated_at
  before update on public.place_visits
  for each row execute function public.set_updated_at();

alter table public.place_visits enable row level security;

create policy "place_visits_select" on public.place_visits for select
  using (public.is_trip_member(trip_id, public.auth_uid()));
create policy "place_visits_insert" on public.place_visits for insert
  with check (public.is_trip_editor(trip_id, public.auth_uid()));
create policy "place_visits_update" on public.place_visits for update
  using (public.is_trip_editor(trip_id, public.auth_uid()));
create policy "place_visits_delete" on public.place_visits for delete
  using (public.is_trip_editor(trip_id, public.auth_uid()));

alter table public.place_visits replica identity full;
alter publication supabase_realtime add table public.place_visits;
