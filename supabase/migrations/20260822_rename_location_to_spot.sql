-- "location" was the wrong word for the smaller half of the model.
--
-- Everything on a map is a location, so the name said nothing about the one
-- property that matters — that this place sits inside another. "Spot" says it:
-- a café, a hotel, a viewpoint is a spot you found while you were somewhere.
-- The larger half keeps its name, so only one value moves.
--
-- Ordering is the whole difficulty, and a first draft got it wrong in a way
-- worth recording: it dropped places_kind_valid, then tried the UPDATE, and was
-- refused by places_anchored_is_location — which also tests the old value, and
-- which the draft only meant to RENAME afterwards. TWO constraints had to come
-- off before a single row could move.
--
-- Explicitly transactional for the same reason. Run without it, that failed
-- draft left the table with places_kind_valid already dropped and the rows
-- unchanged: a database accepting any string in `kind` at all, which is a worse
-- state than either the before or the after.

begin;

-- Both checks that read the old value, off first.
alter table public.places drop constraint if exists places_kind_valid;
alter table public.places drop constraint if exists places_anchored_is_location;

update public.places set kind = 'spot' where kind = 'location';

alter table public.places
  add constraint places_kind_valid check (kind in ('stop', 'spot'));

-- Re-added under the name of the value it now refers to. A constraint still
-- saying "location" reads as a leftover from something else and gets left alone
-- by whoever finds it next.
alter table public.places
  add constraint places_anchored_is_spot
  check (parent_place_id is null or kind = 'spot');

-- The guard's second branch tested the old value. Left alone it would have
-- stopped recognising a place being demoted, which is half of what makes a
-- cycle impossible — and it would have failed SILENTLY, because a test that no
-- longer matches anything simply never fires.
create or replace function public.places_enforce_hierarchy()
returns trigger language plpgsql
set search_path = public
as $$
begin
  if new.parent_place_id is not null then
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

  if (new.parent_place_id is not null or new.kind = 'spot')
     and exists (select 1 from public.places c where c.parent_place_id = new.id) then
    raise exception 'Move the places inside this one out first'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

commit;
