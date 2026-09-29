-- Phase 1: profiles, and Cambridge-only accounts enforced inside the database.
--
-- Two ways in (pilot):
--   1. Quick join (everyone at the pitch): the phone gets its own account (a Supabase
--      "anonymous" account), and the person types their name and @cam.ac.uk email.
--      The email is a label, not a password, so nobody can log in AS someone else by typing
--      their email. The account lives on that device.
--   2. Email code (admins): a verified @cam.ac.uk login that works on any device.
-- Later, quick-join accounts can add and verify their email and keep everything.

-- ---------- Profiles ----------
-- One row per person, visible to other members (from Phase 2). No emails in here.
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(btrim(display_name)) between 1 and 30),
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Phase 1: you can see and rename only yourself. Phase 2 widens reading to fellow members.
create policy "Read own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

create policy "Update own profile" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Row Level Security decides WHICH rows; these grants decide WHICH columns.
-- Profiles are created by the trigger below, and only display_name is editable,
-- so nobody can make themselves an admin.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

-- ---------- Emails (private) ----------
-- Kept apart from profiles so members can never list each other's emails.
-- verified = true when the person proved they own it (email code login).
create table public.account_emails (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null unique check (email = lower(email) and email ~ '^[^@[:space:]]+@cam\.ac\.uk$'),
  verified   boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.account_emails enable row level security;

create policy "Read own email" on public.account_emails
  for select to authenticated using (user_id = (select auth.uid()));

-- No direct writes: rows are added only by join_bnoc() and the new-account trigger.
revoke all on public.account_emails from anon, authenticated;
grant select on public.account_emails to authenticated;

-- ---------- Cambridge-only accounts ----------
-- Any account with an email must be @cam.ac.uk: on sign-up AND when an email is added or changed.
-- Quick-join accounts start with no email; their @cam.ac.uk label is checked by join_bnoc().
create or replace function public.enforce_cam_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_anonymous and new.email is null then
    return new;
  end if;
  if new.email is null or lower(new.email) !~ '^[^@[:space:]]+@cam\.ac\.uk$' then
    raise exception 'BNOC is only open to @cam.ac.uk email addresses'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger enforce_cam_email
  before insert or update of email on auth.users
  for each row execute function public.enforce_cam_email();

-- ---------- Set up each new account ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  if new.email is not null then
    -- A verified login beats an unverified quick-join label for the same address.
    delete from public.account_emails where email = lower(new.email) and not verified;
    insert into public.account_emails (user_id, email, verified) values (new.id, lower(new.email), true);
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Joining (name + email) ----------
-- Called by the app right after quick join, or after a first email-code login (name only).
create or replace function public.join_bnoc(p_display_name text, p_email text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text := btrim(coalesce(p_display_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if v_uid is null then
    raise exception 'You need to be logged in.' using errcode = '28000';
  end if;
  if char_length(v_name) not between 1 and 30 then
    raise exception 'Add your first name (up to 30 characters).' using errcode = '22023';
  end if;

  if not exists (select 1 from public.account_emails where user_id = v_uid) then
    if v_email !~ '^[^@[:space:]]+@cam\.ac\.uk$' then
      raise exception 'BNOC is only open to @cam.ac.uk email addresses.' using errcode = '22023';
    end if;
    begin
      insert into public.account_emails (user_id, email, verified) values (v_uid, v_email, false);
    exception when unique_violation then
      raise exception 'That email is already in use on another device.' using errcode = '23505';
    end;
  end if;

  update public.profiles set display_name = v_name where id = v_uid;
end;
$$;

-- Trigger functions must never be callable through the API; join_bnoc only by logged-in people.
revoke execute on function public.enforce_cam_email() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.join_bnoc(text, text) from public, anon;
grant execute on function public.join_bnoc(text, text) to authenticated;
