-- Roles, site settings, and host game join-code support.

alter table users add column if not exists role text not null default 'host';
alter table users add column if not exists active boolean not null default true;

update users set role = 'site_admin' where id = 1 or username = 'default';

-- Do not auto-promote arbitrary public registrants to Site Admin.
-- Bootstrap a real admin by setting QUIZ_A_ROO_BOOTSTRAP_ADMIN_USERNAME and
-- QUIZ_A_ROO_BOOTSTRAP_ADMIN_PASSWORD before the intended first admin login.
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
