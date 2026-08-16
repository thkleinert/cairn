-- Notes become bullets: rows instead of a text blob.
--
-- Why rows and not a jsonb array or "- " prefixed lines: trips are
-- collaborative, and a single text value is last-write-wins. Two members
-- editing notes at the same time meant one of them silently lost their edit,
-- with no conflict and nothing to notice. A row per bullet syncs
-- independently over realtime, exactly like places already do.
--
-- One table serves both scopes: place_id null is a note about the whole trip,
-- place_id set is a bullet on that place.

-- Needed as the target of the composite foreign key below.
alter table public.places
  add constraint places_id_trip_unique unique (id, trip_id);

create table if not exists public.trip_notes (
  id         uuid primary key default uuid_generate_v4(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  -- null = the whole trip; set = a bullet on that place
  place_id   uuid,
  body       text not null,
  position   int  not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An empty bullet is a UI state, never a stored row.
  constraint trip_notes_body_not_blank check (length(btrim(body)) > 0),

  -- A note's place must belong to the note's trip. MATCH SIMPLE means a null
  -- place_id skips the check entirely, which is exactly right for trip-wide
  -- notes — and it keeps trip_id trustworthy, which every RLS policy here
  -- depends on.
  constraint trip_notes_place_in_trip
    foreign key (place_id, trip_id)
    references public.places(id, trip_id) on delete cascade
);

create index if not exists trip_notes_lookup_idx
  on public.trip_notes(trip_id, place_id, position);

create trigger trip_notes_updated_at before update on public.trip_notes
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- RLS — mirrors places: members read, editors write.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- Realtime
-- ------------------------------------------------------------
alter table public.trip_notes replica identity full;
alter publication supabase_realtime add table public.trip_notes;

-- ------------------------------------------------------------
-- Ordering — same shape as reorder_places: one atomic write, so server,
-- client and realtime can't end up with three different orders.
-- ------------------------------------------------------------
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
-- Backfill the existing free-text notes into single bullets.
-- The old columns are deliberately left in place for now: they are no longer
-- read by the client, and keeping them means this migration is recoverable.
-- ------------------------------------------------------------
insert into public.trip_notes (trip_id, place_id, body, position, created_at)
select p.trip_id, p.id, btrim(p.notes), 0, p.created_at
from public.places p
where coalesce(btrim(p.notes), '') <> ''
  and not exists (select 1 from public.trip_notes n where n.place_id = p.id);

insert into public.trip_notes (trip_id, place_id, body, position, created_at)
select t.id, null, btrim(t.notes), 0, t.created_at
from public.trips t
where coalesce(btrim(t.notes), '') <> ''
  and not exists (
    select 1 from public.trip_notes n where n.trip_id = t.id and n.place_id is null
  );

-- ------------------------------------------------------------
-- Shared view: per-place bullets stay publicly visible (place notes already
-- were, via PlaceDetailSheet's readOnly branch), trip-wide bullets never are.
-- The legacy places.notes text is dropped from the payload too, so the public
-- view can't serve a stale copy alongside the bullets that replaced it.
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
               jsonb_build_object('id', n.id, 'body', n.body, 'position', n.position)
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
