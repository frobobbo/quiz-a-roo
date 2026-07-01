-- Roles, site settings, and host game join-code support.

alter table users add column if not exists role text not null default 'host';
alter table users add column if not exists active boolean not null default true;

update users set role = 'site_admin' where id = 1 or username = 'default';

-- If this deployment already had real users from the login migration,
-- promote the oldest non-default user so someone can sign in as Site Admin.
with first_real_user as (
  select id from users where username <> 'default' order by id limit 1
)
update users
set role = 'site_admin'
where id in (select id from first_real_user)
  and not exists (select 1 from users where role = 'site_admin' and username <> 'default');

alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('site_admin', 'host'));

create table if not exists site_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into site_settings (key, value)
values
  ('registrationEnabled', 'true'::jsonb),
  ('publicBaseUrl', '""'::jsonb),
  ('siteName', '"quiz-a-roo"'::jsonb)
on conflict (key) do nothing;
