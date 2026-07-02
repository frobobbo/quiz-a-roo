-- User login and per-user persistence scoping.

create table if not exists users (
  id bigserial primary key,
  username text unique not null,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Default user preserves pre-login libraries/settings/history after migration.
insert into users (id, username, password_hash)
values (1, 'default', 'disabled$no-login$0')
on conflict (username) do nothing;

select setval('users_id_seq', greatest(1, (select max(id) from users)));

create table if not exists user_sessions (
  token text primary key,
  user_id bigint not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- app_settings: convert global key rows into per-user key rows.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'app_settings' and column_name = 'user_id'
  ) then
    alter table app_settings add column user_id bigint references users(id);
  end if;
end$$;

update app_settings set user_id = 1 where user_id is null;

alter table app_settings alter column user_id set not null;

do $$
declare
  pk_name text;
begin
  select constraint_name into pk_name
  from information_schema.table_constraints
  where table_name = 'app_settings' and constraint_type = 'PRIMARY KEY'
  limit 1;

  if pk_name is not null then
    execute format('alter table app_settings drop constraint %I', pk_name);
  end if;
end$$;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'app_settings' and constraint_name = 'app_settings_user_id_key_key'
  ) then
    alter table app_settings add constraint app_settings_user_id_key_key unique (user_id, key);
  end if;
end$$;

-- libraries: convert global named libraries into per-user named libraries.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'libraries' and column_name = 'user_id'
  ) then
    alter table libraries add column user_id bigint references users(id);
  end if;
end$$;

update libraries set user_id = 1 where user_id is null;

alter table libraries alter column user_id set not null;

do $$
declare
  pk_name text;
begin
  select constraint_name into pk_name
  from information_schema.table_constraints
  where table_name = 'libraries' and constraint_type = 'PRIMARY KEY'
  limit 1;

  if pk_name is not null then
    execute format('alter table libraries drop constraint %I', pk_name);
  end if;
end$$;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'libraries' and constraint_name = 'libraries_user_id_name_key'
  ) then
    alter table libraries add constraint libraries_user_id_name_key unique (user_id, name);
  end if;
end$$;

-- game_history: keep historical rows under the default user, then index per user.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'game_history' and column_name = 'user_id'
  ) then
    alter table game_history add column user_id bigint references users(id);
  end if;
end$$;

update game_history set user_id = 1 where user_id is null;

alter table game_history alter column user_id set not null;

create index if not exists game_history_played_at_idx on game_history (played_at desc);
create index if not exists game_history_user_played_at_idx on game_history (user_id, played_at desc);
create index if not exists user_sessions_expires_at_idx on user_sessions (expires_at);
