-- Places become one of two things: a stop, or a location within one.
--
-- A stop is somewhere you go — a city, an island, a park. A location is
-- somewhere inside a stop: a café, a hotel, a viewpoint. The distinction was
-- already being *guessed* from the shape of a place's address, which works
-- until it doesn't: "73150 Val-d'Isère, Frankreich" carries a postcode and so
-- read as a venue, though it is a town, and a place pinned by long-press has
-- no address to read at all. Recording what a place IS removes the guess from
-- everywhere that consumed it — the notes page hierarchy, the list view, and
-- the map's "show locations" toggle all now ask one question with an answer.
--
-- The address heuristic survives in exactly one place: choosing the default
-- for a newly added place, where being wrong costs one tap to correct.

alter table public.places
  add column if not exists kind text not null default 'stop';

-- Backfill BEFORE the constraints below, not after.
--
-- The column defaults to 'stop', so every already-anchored place starts out
-- violating places_anchored_is_location. Adding that constraint first aborts
-- the whole migration on any database where someone had already filed a place
-- inside another — which is every database this is aimed at.
--
-- Anything anchored is a location, everything else a stop. Deliberately NOT
-- the address heuristic: run against real data it puts Surat Thani, Ko Lanta,
-- Ko Yao Yai, Val-d'Isère and Mayrhofen — five towns and islands — in the
-- "location" bucket, because their addresses carry postcodes or district
-- names. Defaulting to `stop` instead means the migration changes nothing
-- anyone can see: every place is top level today, which is exactly how a stop
-- behaves. Demoting is then a deliberate act, and new places get the guess.
update public.places
   set kind = 'location'
 where parent_place_id is not null
   and kind <> 'location';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'places_kind_valid') then
    alter table public.places
      add constraint places_kind_valid check (kind in ('stop', 'location'));
  end if;

  -- Only a location can sit inside something. This is the half of the model
  -- the database can enforce on its own, and it is the important half: it
  -- guarantees stops are always top level, so the list view and the map
  -- toggle can rely on "stop" meaning exactly that.
  --
  -- The other half — that a parent is itself a stop — cannot be a check
  -- constraint, since a check cannot see the parent row. The client only ever
  -- offers stops as parents, and groupPlaces ignores a parent that is not one,
  -- so a violation renders as an unnested place rather than as a place that
  -- disappears.
  if not exists (select 1 from pg_constraint where conname = 'places_anchored_is_location') then
    alter table public.places
      add constraint places_anchored_is_location
      check (parent_place_id is null or kind = 'location');
  end if;
end $$;

-- The list view and the map toggle both filter on this.
create index if not exists places_kind_idx on public.places(trip_id, kind);
