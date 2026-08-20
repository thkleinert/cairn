-- Notes become an outline: bullets can be nested under one another.
--
-- Stored as a flat list plus a `depth`, NOT as a parent_id tree. The list
-- already has a total order per (trip_id, place_id) — that's what `position`
-- and reorder_trip_notes maintain — and in an outline the tree is implied by
-- that order: an item is a child of the nearest item above it with a smaller
-- depth. Recording depth instead of parentage keeps every existing mechanism
-- working untouched: one atomic reorder RPC over a flat id array, one realtime
-- row per bullet, no recursive CTEs, and deleting a bullet can't orphan rows
-- because nothing points at it.
--
-- The cost is that depth alone can express a shape no outline has — a bullet
-- two levels deeper than the one above it — which two collaborators indenting
-- at the same moment can briefly produce. The client clamps that on render
-- (see normaliseDepths in NoteList), so it shows up as a bullet that sits one
-- level shallower than asked rather than as a broken tree. That's the same
-- trade the rest of this schema makes: degrade visibly, never corrupt.

alter table public.trip_notes
  add column if not exists depth int not null default 0;

-- A ceiling rather than unlimited nesting: each level costs horizontal space,
-- and past this a bullet on a 390px phone has more indent than text. The
-- client enforces the same limit when indenting, so hitting the constraint
-- means a bug, not a user reaching a wall.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'trip_notes_depth_bounded'
  ) then
    alter table public.trip_notes
      add constraint trip_notes_depth_bounded check (depth between 0 and 5);
  end if;
end $$;

-- ------------------------------------------------------------
-- Shared view: the public trip page renders the same outline, so it needs the
-- depth too. Without it every bullet flattens to the outer level there and a
-- nested list reads as an unordered pile.
-- ------------------------------------------------------------
create or replace function public.get_shared_trip(p_token uuid)
returns jsonb
language sql security definer stable
set search_path = public
as $$
  select jsonb_build_object(
    'trip', to_jsonb(t) - 'share_token' - 'owner_id' - 'notes',
    'tags', coalesce(
      (select jsonb_agg(to_jsonb(tg)) from public.tags tg where tg.trip_id = t.id),
      '[]'::jsonb),
    'places', coalesce((
      select jsonb_agg(
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
