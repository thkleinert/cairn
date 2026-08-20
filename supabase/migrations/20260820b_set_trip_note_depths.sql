-- Setting the depth of a bullet and its descendants, atomically.
--
-- The client was issuing one UPDATE per distinct depth, so indenting a subtree
-- spanning two levels took two statements. A failure on the second left the
-- first committed: the client rolled its own state back and said the change
-- had not happened, while the successful half stayed in the database — and
-- because it fired a realtime event, the refetch it triggered overwrote the
-- rollback with the half-applied shape. An outline nobody asked for, under a
-- toast saying nothing had changed.
--
-- Every other structural write in this table already goes through an atomic
-- RPC (reorder_trip_notes) for exactly this reason. This is the matching one
-- for depth, and it is one statement no matter how large the subtree.

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
