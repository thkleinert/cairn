-- Trip-wide notes: a free-form scratchpad per trip, distinct from
-- `description` (a short subtitle rendered in the trip list).
--
-- Idempotent so it is safe to re-run against a project that already has it.

alter table public.trips add column if not exists notes text;

-- Editors may write it; the column grant is an allowlist, so it must be
-- re-issued in full rather than amended.
grant update (name, description, notes, start_date, end_date, cover_image_url)
  on public.trips to authenticated;

grant select (id, name, description, notes, start_date, end_date, cover_image_url,
              owner_id, created_at, updated_at)
  on public.trips to authenticated;

-- get_shared_trip scrubs by DENYLIST, so `notes` would be published to every
-- anonymous share-link holder the moment the column exists. This is where door
-- codes and booking references live — name it explicitly.
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
        (to_jsonb(p) - 'added_by' - 'google_place_id') || jsonb_build_object(
          'tags', coalesce(
            (select jsonb_agg(to_jsonb(tg2))
             from public.place_tags pt
             join public.tags tg2 on tg2.id = pt.tag_id
             where pt.place_id = p.id),
            '[]'::jsonb),
          'images', coalesce(
            (select jsonb_agg(to_jsonb(pi) order by pi.position)
             from public.place_images pi where pi.place_id = p.id),
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
