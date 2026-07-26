-- Enable required extensions
create extension if not exists "uuid-ossp";

-- ============================================================
-- TABLES
-- ============================================================

create table public.trips (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  description text,
  start_date  date,
  end_date    date,
  share_token uuid unique default uuid_generate_v4(),
  cover_image_url text,
  owner_id    uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.trip_members (
  id        uuid primary key default uuid_generate_v4(),
  trip_id   uuid not null references public.trips(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'editor' check (role in ('owner','editor','viewer')),
  joined_at timestamptz not null default now(),
  unique (trip_id, user_id)
);

create table public.tags (
  id      uuid primary key default uuid_generate_v4(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  name    text not null,
  color   text not null default '#6366f1',
  icon    text,
  unique (trip_id, name)
);

create table public.places (
  id              uuid primary key default uuid_generate_v4(),
  trip_id         uuid not null references public.trips(id) on delete cascade,
  name            text not null,
  address         text,
  latitude        double precision not null,
  longitude       double precision not null,
  google_place_id text,
  status          text not null default 'planned' check (status in ('planned','visited')),
  visited_at      timestamptz,
  notes           text,
  source_url      text,
  image_url       text,
  added_by        uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.place_tags (
  place_id uuid not null references public.places(id) on delete cascade,
  tag_id   uuid not null references public.tags(id) on delete cascade,
  primary key (place_id, tag_id)
);

create table public.place_images (
  id         uuid primary key default uuid_generate_v4(),
  place_id   uuid not null references public.places(id) on delete cascade,
  url        text not null,
  caption    text,
  position   integer not null default 0,
  created_at timestamptz not null default now()
);

-- ============================================================
-- UPDATED_AT TRIGGERS
-- ============================================================

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trips_updated_at before update on public.trips
  for each row execute function public.set_updated_at();

create trigger places_updated_at before update on public.places
  for each row execute function public.set_updated_at();

-- ============================================================
-- AUTO-ADD OWNER AS MEMBER
-- ============================================================

create or replace function public.add_trip_owner_as_member()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.trip_members (trip_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end;
$$;

create trigger trip_created after insert on public.trips
  for each row execute function public.add_trip_owner_as_member();

-- ============================================================
-- HELPERS
-- ============================================================

create or replace function public.is_trip_member(trip uuid, usr uuid)
returns boolean language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public.trip_members
    where trip_id = trip and user_id = usr
  );
$$;

-- Writes require owner or editor; viewers are genuinely read-only.
create or replace function public.is_trip_editor(trip uuid, usr uuid)
returns boolean language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public.trip_members
    where trip_id = trip and user_id = usr and role in ('owner', 'editor')
  );
$$;

-- PostgreSQL 15+ restricts non-superuser roles from reading custom GUC parameters
-- set by PostgREST (request.jwt.*). Inline the JWT parse inside a SECURITY DEFINER
-- function so it runs as postgres (superuser) which can access request.jwt.claims.
create or replace function public.auth_uid()
returns uuid language sql security definer stable
set search_path = extensions, public, auth
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::json->>'sub'
  )::uuid
$$;

grant execute on function public.auth_uid() to anon, authenticated;

-- SECURITY DEFINER RPC for trip creation — bypasses RLS INSERT evaluation entirely.
-- auth.uid() is called within SECURITY DEFINER context (postgres superuser) where
-- request.jwt.claims is readable, avoiding the PostgREST GUC restriction in PG17.
create or replace function public.create_trip(
  p_name        text,
  p_description text default null,
  p_start_date  date default null,
  p_end_date    date default null
)
returns public.trips
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid  uuid;
  v_trip public.trips;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  insert into public.trips (name, description, start_date, end_date, owner_id)
  values (p_name, p_description, p_start_date, p_end_date, v_uid)
  returning * into v_trip;
  return v_trip;
end;
$$;

grant execute on function public.create_trip(text, text, date, date) to authenticated;

-- ============================================================
-- RLS
-- ============================================================

alter table public.trips enable row level security;
alter table public.trip_members enable row level security;
alter table public.tags enable row level security;
alter table public.places enable row level security;
alter table public.place_tags enable row level security;

-- trips
-- owner_id check is first: avoids the window between INSERT and the after-insert
-- trigger that adds owner to trip_members (PostgREST evaluates SELECT policy on RETURNING).
create policy "trip_select" on public.trips for select
  using (
    owner_id = public.auth_uid()
    or public.is_trip_member(id, public.auth_uid())
    or share_token::text = nullif(
      current_setting('request.jwt.claims', true), ''
    )::json->>'share_token'
  );

create policy "trip_insert" on public.trips for insert
  with check (owner_id = public.auth_uid());

create policy "trip_update" on public.trips for update
  using (public.is_trip_editor(id, public.auth_uid()))
  with check (public.is_trip_editor(id, public.auth_uid()));

-- Editors may change trip *content* only. owner_id and share_token sit outside
-- this column grant, so a PATCH touching them is rejected outright — without
-- this, any member could seize ownership by writing owner_id. (updated_at is
-- written by a trigger, which column grants don't constrain.)
revoke update on table public.trips from anon, authenticated;
grant update (name, description, start_date, end_date, cover_image_url)
  on public.trips to authenticated;

create policy "trip_delete" on public.trips for delete
  using (owner_id = public.auth_uid());

-- trip_members
create policy "tm_select" on public.trip_members for select
  using (public.is_trip_member(trip_id, public.auth_uid()));

create policy "tm_insert" on public.trip_members for insert
  with check (
    exists (
      select 1 from public.trips t
      where t.id = trip_id and t.owner_id = public.auth_uid()
    )
  );

create policy "tm_delete" on public.trip_members for delete
  using (
    user_id = public.auth_uid()
    or exists (
      select 1 from public.trips t
      where t.id = trip_id and t.owner_id = public.auth_uid()
    )
  );

-- tags
create policy "tags_select" on public.tags for select
  using (public.is_trip_member(trip_id, public.auth_uid()));
create policy "tags_insert" on public.tags for insert
  with check (public.is_trip_editor(trip_id, public.auth_uid()));
create policy "tags_update" on public.tags for update
  using (public.is_trip_editor(trip_id, public.auth_uid()));
create policy "tags_delete" on public.tags for delete
  using (public.is_trip_editor(trip_id, public.auth_uid()));

-- places
create policy "places_select" on public.places for select
  using (public.is_trip_member(trip_id, public.auth_uid()));
create policy "places_insert" on public.places for insert
  with check (public.is_trip_editor(trip_id, public.auth_uid()));
create policy "places_update" on public.places for update
  using (public.is_trip_editor(trip_id, public.auth_uid()));
create policy "places_delete" on public.places for delete
  using (public.is_trip_editor(trip_id, public.auth_uid()));

-- place_tags
create policy "place_tags_select" on public.place_tags for select
  using (
    exists (select 1 from public.places p
      where p.id = place_id and public.is_trip_member(p.trip_id, public.auth_uid()))
  );
create policy "place_tags_insert" on public.place_tags for insert
  with check (
    exists (select 1 from public.places p
      where p.id = place_id and public.is_trip_editor(p.trip_id, public.auth_uid()))
  );
create policy "place_tags_delete" on public.place_tags for delete
  using (
    exists (select 1 from public.places p
      where p.id = place_id and public.is_trip_editor(p.trip_id, public.auth_uid()))
  );

-- ============================================================
-- COLLABORATION RPCs
-- ============================================================

-- Returns trip members with their email (reads auth.users via SECURITY DEFINER)
create or replace function public.get_trip_members(p_trip_id uuid)
returns table (
  id        uuid,
  trip_id   uuid,
  user_id   uuid,
  role      text,
  joined_at timestamptz,
  email     text
)
language sql security definer stable
set search_path = public, auth
as $$
  select
    tm.id,
    tm.trip_id,
    tm.user_id,
    tm.role,
    tm.joined_at,
    u.email
  from public.trip_members tm
  join auth.users u on u.id = tm.user_id
  where tm.trip_id = p_trip_id
    and public.is_trip_member(p_trip_id, auth.uid())
  order by
    case tm.role when 'owner' then 0 else 1 end,
    tm.joined_at
$$;

grant execute on function public.get_trip_members(uuid) to authenticated;

-- Invite an existing user by email (owner only)
create or replace function public.invite_collaborator(
  p_trip_id uuid,
  p_email   text,
  p_role    text default 'editor'
)
returns table (
  id        uuid,
  trip_id   uuid,
  user_id   uuid,
  role      text,
  joined_at timestamptz,
  email     text
)
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_uid       uuid;
  v_target_id uuid;
  v_member_id uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'Not authenticated'; end if;

  if p_role not in ('editor', 'viewer') then
    raise exception 'Role must be editor or viewer';
  end if;

  -- Alias the table: this function RETURNS TABLE(id ...), so a bare `id`
  -- reference is ambiguous between that output column and trips.id.
  if not exists (
    select 1 from public.trips t where t.id = p_trip_id and t.owner_id = v_uid
  ) then
    raise exception 'Only the trip owner can invite collaborators';
  end if;

  select u.id into v_target_id from auth.users u where lower(u.email) = lower(p_email);
  if v_target_id is null then
    raise exception 'No account found with email %', p_email;
  end if;

  if v_target_id = v_uid then
    raise exception 'You are already the owner of this trip';
  end if;

  insert into public.trip_members (trip_id, user_id, role)
  values (p_trip_id, v_target_id, p_role)
  on conflict (trip_id, user_id) do update set role = excluded.role
  returning public.trip_members.id into v_member_id;

  return query
    select tm.id, tm.trip_id, tm.user_id, tm.role, tm.joined_at, u.email
    from public.trip_members tm
    join auth.users u on u.id = tm.user_id
    where tm.id = v_member_id;
end;
$$;

grant execute on function public.invite_collaborator(uuid, text, text) to authenticated;

-- Remove a collaborator (owner only, cannot remove owner)
create or replace function public.remove_collaborator(
  p_trip_id uuid,
  p_user_id uuid
)
returns void
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'Not authenticated'; end if;

  if not exists (
    select 1 from public.trips where id = p_trip_id and owner_id = v_uid
  ) then
    raise exception 'Only the trip owner can remove collaborators';
  end if;

  if exists (select 1 from public.trips where id = p_trip_id and owner_id = p_user_id) then
    raise exception 'Cannot remove the trip owner';
  end if;

  delete from public.trip_members where trip_id = p_trip_id and user_id = p_user_id;
end;
$$;

grant execute on function public.remove_collaborator(uuid, uuid) to authenticated;

-- ============================================================
-- TRIP INVITES — pending memberships via a copyable link
-- ------------------------------------------------------------
-- Inviting an email that already has an account adds them straight to
-- trip_members. Inviting one that doesn't creates a token-based invite; the
-- owner shares the link, and whoever opens it and signs in redeems the token
-- (acceptance is by token, email is just a label of who it was meant for).
-- ============================================================

create table public.trip_invites (
  id          uuid primary key default uuid_generate_v4(),
  trip_id     uuid not null references public.trips(id) on delete cascade,
  email       text,
  role        text not null default 'editor' check (role in ('editor', 'viewer')),
  token       uuid not null unique default uuid_generate_v4(),
  invited_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  expires_at  timestamptz not null default (now() + interval '30 days')
);
create index trip_invites_trip_id_idx on public.trip_invites(trip_id);

alter table public.trip_invites enable row level security;

-- Tokens are bearer credentials: only the owner (who hands the link out) may
-- read them — a viewer-role member must not be able to lift a pending editor
-- token and pass it to an outsider. All writes go through the SECURITY
-- DEFINER RPCs below; the accept screen's token lookup is its own RPC.
create policy "trip_invites_select" on public.trip_invites for select
  using (
    exists (select 1 from public.trips t
      where t.id = trip_id and t.owner_id = public.auth_uid())
  );

-- Create an invite. Existing account -> added immediately; otherwise a
-- pending token invite (reusing an open one for the same email if present).
create or replace function public.create_trip_invite(
  p_trip_id uuid,
  p_email   text,
  p_role    text default 'editor'
)
returns jsonb
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_uid    uuid;
  v_target uuid;
  v_token  uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_role not in ('editor', 'viewer') then
    raise exception 'Role must be editor or viewer';
  end if;
  if not exists (
    select 1 from public.trips t where t.id = p_trip_id and t.owner_id = v_uid
  ) then
    raise exception 'Only the trip owner can invite collaborators';
  end if;

  select u.id into v_target from auth.users u where lower(u.email) = lower(p_email);

  if v_target is not null then
    if v_target = v_uid then raise exception 'You are already the owner of this trip'; end if;
    insert into public.trip_members (trip_id, user_id, role)
    values (p_trip_id, v_target, p_role)
    on conflict (trip_id, user_id) do update set role = excluded.role;
    return jsonb_build_object('status', 'added', 'email', p_email, 'role', p_role);
  end if;

  select token into v_token
  from public.trip_invites
  where trip_id = p_trip_id and lower(email) = lower(p_email) and accepted_at is null
  limit 1;

  if v_token is null then
    insert into public.trip_invites (trip_id, email, role, invited_by)
    values (p_trip_id, p_email, p_role, v_uid)
    returning token into v_token;
  else
    update public.trip_invites set role = p_role where token = v_token;
  end if;

  return jsonb_build_object('status', 'invited', 'email', p_email, 'role', p_role, 'token', v_token);
end;
$$;

grant execute on function public.create_trip_invite(uuid, text, text) to authenticated;

-- Public token lookup for the accept screen (name/role/inviter, no row access).
create or replace function public.get_trip_invite(p_token uuid)
returns table (
  trip_id       uuid,
  trip_name     text,
  role          text,
  inviter_email text,
  accepted      boolean
)
language sql security definer stable
set search_path = public, auth
as $$
  select i.trip_id, t.name, i.role, u.email, (i.accepted_at is not null)
  from public.trip_invites i
  join public.trips t on t.id = i.trip_id
  join auth.users u on u.id = i.invited_by
  where i.token = p_token;
$$;

grant execute on function public.get_trip_invite(uuid) to anon, authenticated;

-- Redeem an invite for the signed-in user; idempotent if already a member.
create or replace function public.accept_trip_invite(p_token uuid)
returns uuid
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
  v_inv public.trip_invites;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_inv from public.trip_invites where token = p_token;
  if not found then raise exception 'Invite not found'; end if;

  if exists (
    select 1 from public.trip_members where trip_id = v_inv.trip_id and user_id = v_uid
  ) then
    return v_inv.trip_id;
  end if;

  if v_inv.accepted_at is not null then
    raise exception 'This invite has already been used';
  end if;

  if v_inv.expires_at < now() then
    raise exception 'This invite has expired';
  end if;

  insert into public.trip_members (trip_id, user_id, role)
  values (v_inv.trip_id, v_uid, v_inv.role)
  on conflict (trip_id, user_id) do nothing;

  update public.trip_invites
    set accepted_at = now(), accepted_by = v_uid
  where token = p_token;

  return v_inv.trip_id;
end;
$$;

grant execute on function public.accept_trip_invite(uuid) to authenticated;

-- Revoke a pending invite (owner only).
create or replace function public.revoke_trip_invite(p_token uuid)
returns void
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'Not authenticated'; end if;
  delete from public.trip_invites i
  using public.trips t
  where i.token = p_token and t.id = i.trip_id and t.owner_id = v_uid;
end;
$$;

grant execute on function public.revoke_trip_invite(uuid) to authenticated;

-- ============================================================
-- PUBLIC SHARE VIEW (bypasses RLS via share token)
-- ============================================================

-- security_invoker is load-bearing: without it the view executes as its owner,
-- BYPASSING trips RLS — any anon-key holder could dump every trip including
-- every share_token. With it, callers only see what trips RLS grants them.
-- No grants: nothing in the frontend reads this view.
create or replace view public.public_trip_view
  with (security_invoker = true) as
  select
    t.id,
    t.name,
    t.description,
    t.start_date,
    t.end_date,
    t.share_token,
    t.cover_image_url
  from public.trips t;

revoke select on public.public_trip_view from anon, authenticated;

-- ============================================================
-- INDEXES
-- ============================================================

create index trips_owner_id_idx on public.trips(owner_id);
create index trip_members_user_id_idx on public.trip_members(user_id);
create index places_trip_id_idx on public.places(trip_id);
create index places_google_place_id_idx on public.places(google_place_id);
create index tags_trip_id_idx on public.tags(trip_id);

-- ============================================================
-- REALTIME
-- ------------------------------------------------------------
-- usePlaces/useTags subscribe to postgres_changes on these tables; without
-- this the channels connect and simply never fire (collaborators never see
-- each other's edits live). replica identity full so DELETE events carry the
-- trip_id the client-side filter needs.
-- ============================================================
alter table public.places replica identity full;
alter table public.tags replica identity full;
alter publication supabase_realtime add table public.places, public.tags;

-- ============================================================
-- PLACE COMMENTS  (feature/place-comments prototype)
-- ------------------------------------------------------------
-- A per-place discussion thread so collaborators can talk through a spot
-- ("should we book this?") separately from the single-author notes field.
-- Any trip member may read and post; you may only delete your own comment
-- (the trip owner may delete any, to moderate). Apply this whole block, then
-- flip USE_MOCK to false in src/hooks/useComments.ts to go live.
-- ============================================================

create table public.place_comments (
  id         uuid primary key default uuid_generate_v4(),
  place_id   uuid not null references public.places(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index place_comments_place_id_idx on public.place_comments(place_id, created_at);

alter table public.place_comments enable row level security;

-- Membership is checked through the parent place's trip, mirroring places/tags.
create policy "place_comments_select" on public.place_comments for select
  using (
    exists (select 1 from public.places p
      where p.id = place_id and public.is_trip_member(p.trip_id, public.auth_uid()))
  );

create policy "place_comments_insert" on public.place_comments for insert
  with check (
    user_id = public.auth_uid()
    and exists (select 1 from public.places p
      where p.id = place_id and public.is_trip_member(p.trip_id, public.auth_uid()))
  );

-- Author can delete their own; trip owner can delete anyone's (moderation).
create policy "place_comments_delete" on public.place_comments for delete
  using (
    user_id = public.auth_uid()
    or exists (
      select 1 from public.places p
      join public.trips t on t.id = p.trip_id
      where p.id = place_id and t.owner_id = public.auth_uid()
    )
  );

-- Returns a place's comments with each author's email (reads auth.users via
-- SECURITY DEFINER, same pattern as get_trip_members).
create or replace function public.get_place_comments(p_place_id uuid)
returns table (
  id         uuid,
  place_id   uuid,
  user_id    uuid,
  email      text,
  body       text,
  created_at timestamptz
)
language sql security definer stable
set search_path = public, auth
as $$
  select c.id, c.place_id, c.user_id, u.email, c.body, c.created_at
  from public.place_comments c
  join auth.users u on u.id = c.user_id
  join public.places p on p.id = c.place_id
  where c.place_id = p_place_id
    and public.is_trip_member(p.trip_id, auth.uid())
  order by c.created_at;
$$;

grant execute on function public.get_place_comments(uuid) to authenticated;

-- Inserts a comment as the caller and returns it with the author email joined,
-- so the client can append it to the thread without a second round-trip.
create or replace function public.add_place_comment(
  p_place_id uuid,
  p_body     text
)
returns table (
  id         uuid,
  place_id   uuid,
  user_id    uuid,
  email      text,
  body       text,
  created_at timestamptz
)
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
  v_id  uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'Not authenticated'; end if;

  if not exists (
    select 1 from public.places p
    where p.id = p_place_id and public.is_trip_member(p.trip_id, v_uid)
  ) then
    raise exception 'Not a member of this trip';
  end if;

  insert into public.place_comments (place_id, user_id, body)
  values (p_place_id, v_uid, p_body)
  returning place_comments.id into v_id;

  return query
    select c.id, c.place_id, c.user_id, u.email, c.body, c.created_at
    from public.place_comments c
    join auth.users u on u.id = c.user_id
    where c.id = v_id;
end;
$$;

grant execute on function public.add_place_comment(uuid, text) to authenticated;

-- ============================================================
-- ACTIVITY FEED  (feature/place-comments prototype)
-- ------------------------------------------------------------
-- Powers the in-app notification bell: a row is recorded whenever someone adds
-- a place or posts a comment, and each user sees activity from every trip they
-- belong to (except their own actions).
--
-- An item leaves a user's inbox if EITHER it predates their "mark all read"
-- cursor (activity_seen) OR it was individually dismissed (activity_dismissed)
-- — by tapping through to its place or swiping it away, which are the same
-- action. The feed itself is never cleared — it's a rolling window
-- (get_activity returns the newest 50); dismissed items simply drop out.
--
-- Apply this block, then flip USE_MOCK to false in
-- src/hooks/useNotifications.ts to go live.
-- ============================================================

create table public.activity (
  id         uuid primary key default uuid_generate_v4(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  actor_id   uuid not null references auth.users(id) on delete cascade,
  type       text not null check (type in ('place_added', 'comment_added')),
  place_id   uuid references public.places(id) on delete cascade,
  comment_id uuid references public.place_comments(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index activity_trip_id_idx on public.activity(trip_id, created_at desc);

-- Per-user "mark all read" cursor: everything at or before this is read.
create table public.activity_seen (
  user_id uuid primary key references auth.users(id) on delete cascade,
  seen_at timestamptz not null default now()
);

-- Per-user, per-item dismissals — recorded whether the user tapped through to
-- the place or swiped the row away (one and the same action). Hides the item
-- from that user's feed; the shared activity row itself stays for other trip
-- members.
create table public.activity_dismissed (
  user_id      uuid not null references auth.users(id) on delete cascade,
  activity_id  uuid not null references public.activity(id) on delete cascade,
  dismissed_at timestamptz not null default now(),
  primary key (user_id, activity_id)
);

alter table public.activity enable row level security;
alter table public.activity_seen enable row level security;
alter table public.activity_dismissed enable row level security;

create policy "activity_dismissed_all" on public.activity_dismissed for all
  using (user_id = public.auth_uid())
  with check (user_id = public.auth_uid());

create policy "activity_select" on public.activity for select
  using (public.is_trip_member(trip_id, public.auth_uid()));

create policy "activity_seen_all" on public.activity_seen for all
  using (user_id = public.auth_uid())
  with check (user_id = public.auth_uid());

-- Record a row whenever a place is added… A logging trigger must never fail
-- the write it observes: when the actor can't be attributed (service-role
-- inserts, SQL editor, imports) skip the activity row instead of violating
-- activity.actor_id NOT NULL and rolling back the place insert itself.
create or replace function public.log_place_added()
returns trigger language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_actor uuid;
begin
  v_actor := coalesce(new.added_by, auth.uid());
  if v_actor is null then return new; end if;
  insert into public.activity (trip_id, actor_id, type, place_id)
  values (new.trip_id, v_actor, 'place_added', new.id);
  return new;
end;
$$;

create trigger place_added_activity after insert on public.places
  for each row execute function public.log_place_added();

-- …and whenever a comment is posted.
create or replace function public.log_comment_added()
returns trigger language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_trip uuid;
begin
  select trip_id into v_trip from public.places where id = new.place_id;
  insert into public.activity (trip_id, actor_id, type, place_id, comment_id)
  values (v_trip, new.user_id, 'comment_added', new.place_id, new.id);
  return new;
end;
$$;

create trigger comment_added_activity after insert on public.place_comments
  for each row execute function public.log_comment_added();

-- Inbox for the current user: active (not-yet-dismissed) activity across their
-- trips, other people's actions only, newest first, with author email +
-- place/trip names joined in. Dismissed items are filtered out entirely — the
-- feed only ever shows what still needs attention.
create or replace function public.get_activity()
returns table (
  id          uuid,
  type        text,
  actor_email text,
  trip_id     uuid,
  trip_name   text,
  place_id    uuid,
  place_name  text,
  snippet     text,
  created_at  timestamptz
)
language sql security definer stable
set search_path = public, auth
as $$
  select
    a.id,
    a.type,
    u.email,
    a.trip_id,
    t.name,
    a.place_id,
    p.name,
    c.body,
    a.created_at
  from public.activity a
  join auth.users u on u.id = a.actor_id
  join public.trips t on t.id = a.trip_id
  left join public.places p on p.id = a.place_id
  left join public.place_comments c on c.id = a.comment_id
  left join public.activity_seen s on s.user_id = auth.uid()
  left join public.activity_dismissed d on d.activity_id = a.id and d.user_id = auth.uid()
  where public.is_trip_member(a.trip_id, auth.uid())
    and a.actor_id <> auth.uid()
    and not coalesce(a.created_at <= s.seen_at, false)  -- not marked-all-read
    and d.activity_id is null                            -- not dismissed
  order by a.created_at desc
  limit 50;
$$;

grant execute on function public.get_activity() to authenticated;

-- Dismiss a single item for this user — tapping through to its place or
-- swiping it away, which are the same action.
create or replace function public.dismiss_activity(p_activity_id uuid)
returns void
language sql security definer
set search_path = public, auth
as $$
  insert into public.activity_dismissed (user_id, activity_id)
  values (auth.uid(), p_activity_id)
  on conflict (user_id, activity_id) do nothing;
$$;

grant execute on function public.dismiss_activity(uuid) to authenticated;

-- Mark everything up to now as seen — the "Mark all read" button.
create or replace function public.mark_activity_seen()
returns void
language sql security definer
set search_path = public, auth
as $$
  insert into public.activity_seen (user_id, seen_at)
  values (auth.uid(), now())
  on conflict (user_id) do update set seen_at = now();
$$;

grant execute on function public.mark_activity_seen() to authenticated;
