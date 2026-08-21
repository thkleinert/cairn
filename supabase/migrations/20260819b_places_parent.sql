-- Anchor a place to another place.
--
-- A café or a beach bar is somewhere *in* a city, not a peer of it. Without
-- this every marked place claimed its own top-level section on the notes page,
-- so a trip with a city and six places in it read as seven unrelated headings.
--
-- Deliberately just a parent pointer on places, and deliberately used by the
-- notes page only for now. The map and the place list are unchanged: this
-- records a relationship that is true regardless of who reads it, and one
-- surface uses it. If the list view wants it later the data is already there.

alter table public.places
  add column if not exists parent_place_id uuid;

do $$
begin
  -- Same trip as the child, enforced by the database rather than by the UI
  -- that happens to write it. MATCH SIMPLE means a null parent skips the check
  -- entirely, which is what an unanchored place needs. Set null rather than
  -- cascade: deleting a city must not delete the cafés in it — they become
  -- top-level again, which is recoverable, where a cascade is not.
  --
  -- The column list on SET NULL is not optional here. A bare `on delete set
  -- null` on a composite key nulls EVERY referencing column, so deleting a
  -- parent tried to null the child's trip_id too and failed against its
  -- not-null constraint — meaning a city with anything anchored to it could
  -- not be deleted at all. Naming the column confines it to the parent
  -- pointer. Requires PostgreSQL 15+, which Supabase has been on since 2023.
  if not exists (select 1 from pg_constraint where conname = 'places_parent_in_trip') then
    alter table public.places
      add constraint places_parent_in_trip
      foreign key (parent_place_id, trip_id)
      references public.places(id, trip_id)
      on delete set null (parent_place_id);
  end if;

  -- A place cannot be inside itself. Longer cycles (a in b, b in a) can't be
  -- expressed as a check constraint; the client renders only one level of
  -- nesting and treats any place whose parent itself has a parent as
  -- top-level, so a cycle shows up as two unnested headings rather than as
  -- places that vanish from the page.
  if not exists (select 1 from pg_constraint where conname = 'places_parent_not_self') then
    alter table public.places
      add constraint places_parent_not_self
      check (parent_place_id is null or parent_place_id <> id);
  end if;
end $$;

-- Looking up a parent's children is the notes page's main read.
create index if not exists places_parent_idx
  on public.places(parent_place_id) where parent_place_id is not null;
