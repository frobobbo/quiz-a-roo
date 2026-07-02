create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists libraries (
  name text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists game_history (
  id bigserial primary key,
  entry jsonb not null,
  played_at timestamptz not null default now()
);

create index if not exists game_history_played_at_idx on game_history (played_at desc);
