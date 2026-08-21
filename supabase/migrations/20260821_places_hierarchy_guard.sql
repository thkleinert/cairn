-- The half of the stop/location model a CHECK constraint cannot see.
--
-- A check can only read the row being written, so three rules were left to the
-- client: that a parent is itself a stop, that a parent is not itself anchored,
-- and that a place holding locations cannot move inside one. Every one of those
-- reads the writer's local snapshot of the trip, which is exactly what two
-- collaborators do not share.
--
-- Concretely: A files X inside Y while B, whose realtime channel has not yet
-- delivered A's write, files Y inside X. Both snapshots say the other place is
-- an unanchored stop with nothing in it, so both guards pass and both writes
-- satisfy places_anchored_is_location. The result is a cycle that no screen can
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
  -- location. Both would orphan whatever it holds, since only a stop can be
  -- a parent.
  if (new.parent_place_id is not null or new.kind = 'location')
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
drop trigger if exists places_hierarchy_guard on public.places;
create trigger places_hierarchy_guard
  before insert or update of kind, parent_place_id on public.places
  for each row execute function public.places_enforce_hierarchy();
