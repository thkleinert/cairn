-- Sources fold into notes.
--
-- `places.source_urls` was a separate list of links pinned to a place, edited
-- through its own row of pills on the place detail sheet. The notes page now
-- renders any URL in a bullet as the same host-labelled pill, which makes the
-- separate list a second place to put the same thing — with the worse of the
-- two editors, since a source could carry no note about why it was worth
-- keeping.
--
-- Each stored URL becomes a bullet on its own place, so nothing a member saved
-- disappears from the UI, and the column then goes.
--
-- Guarded rather than idempotent-by-clause: the drop at the end is what makes
-- a second run a no-op, and doing it this way means a re-run can't insert the
-- bullets twice.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'places'
      and column_name = 'source_urls'
  ) then
    return;
  end if;

  insert into public.trip_notes (trip_id, place_id, body, position, created_at)
  select
    s.trip_id,
    s.place_id,
    s.url,
    -- After whatever bullets the place already has. max+1 per place, not a
    -- global offset: positions are scoped to (trip_id, place_id).
    coalesce(
      (select max(n.position) from public.trip_notes n where n.place_id = s.place_id),
      -1
    ) + s.rank,
    -- The place's own timestamp: a source has no creation time of its own,
    -- and now() would sort every backfilled bullet as newer than every note
    -- actually written today.
    s.created_at
  from (
    select
      p.trip_id,
      p.id as place_id,
      p.created_at,
      -- The client only recognises a link by an explicit scheme or a leading
      -- "www." — a bare "wien.info" rule would turn ordinary prose like
      -- "Closed Mondays.Book ahead" into a link. Sources were never
      -- normalised on the way in, so schemeless ones are given https:// here
      -- rather than being left to render as plain text.
      case
        when btrim(u.url) ~* '^[a-z][a-z0-9+.-]*://' then btrim(u.url)
        else 'https://' || btrim(u.url)
      end as url,
      -- Numbered AFTER the blanks are filtered out, not by the array's own
      -- ordinality: an empty string earlier in source_urls would otherwise
      -- consume a position and leave the first real bullet starting at 2.
      row_number() over (partition by p.id order by u.ord) as rank
    from public.places p,
         unnest(p.source_urls) with ordinality as u(url, ord)
    where btrim(u.url) <> ''
  ) s;

  -- created_by stays null — these rows have no author to attribute them to,
  -- which the column already allows (it is `on delete set null` for exactly
  -- the case of an authorless note).

  alter table public.places drop column source_urls;
end $$;
