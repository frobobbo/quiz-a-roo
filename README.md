# Quiz-a-Roo

A Jeopardy-style multiplayer trivia game for quiz-a-roo nights. One host runs the game from a laptop, players join on their phones, and the game board displays on a TV.

## Setup

```bash
npm install
npm start
```

The server runs on **port 3000**.

## Screens

| URL | Device | Purpose |
|-----|--------|---------|
| `/board` | TV / projector | Game board display |
| `/host` | Host laptop | Game control panel (PIN: `2653`) |
| `/player` | Player phones | Buzz in + wager |
| `/settings` | Host laptop | API keys, game defaults, appearance |

Players scan a QR code on the board screen to join.

## Configuration

All configuration lives at `/settings` (host-gated). No manual file editing required.

- **API Keys** — Enter your Anthropic API key to enable AI question generation. The key is saved to `config.json` on the server and takes effect immediately without a restart.
- **Game Defaults** — Set default buzz time, answer time, lockout rules, Daily Doubles, and Team Mode. Defaults persist across games.
- **Appearance** — Choose from 7 color themes or build a custom one with the color picker.

Get an Anthropic API key at [console.anthropic.com](https://console.anthropic.com).

## User login

Hosts must sign in at `/login` before opening `/host`. Entering a new username creates that user; using an existing username requires the original password. The existing host PIN (`2653`) remains as a second gate for the host panel.

Each user gets isolated persisted data:

- quiz libraries/categories/questions
- active library and host settings
- game defaults/theme settings
- game history

**Current active-board limitation:** persisted data is scoped per user, but the live Socket.IO game board remains process-global in this pass. In practice, one active hosted game should run per app instance at a time. Switching host users loads that user's persisted board/library/settings state.

## Features

- **Two rounds** with Daily Doubles and Final Jeopardy
- **Team mode** — players create and join teams with shared scoring
- **AI question generation** — generate full categories or individual questions via the Anthropic API
- **Custom question library** — add, edit, import, and export categories and questions
- **7 color themes** plus a custom colorway picker
- **Sound effects** via Web Audio API (no audio files required)
- **Game history** — results saved locally and viewable from the host panel
- **Tiebreaker round** automatically triggered when players are tied at game end

## Persistence

### File mode (default)

Without `DATABASE_URL` the app stores everything in `DATA_DIR` (default: the repo root):

| File | Contents |
|------|----------|
| `libraries/*.json` | Named quiz libraries |
| `app-settings.json` | Theme, game defaults, TTS settings |
| `history.json` | Last 50 game results |
| `config.json` | Anthropic / ElevenLabs API keys |

### PostgreSQL mode

Set `DATABASE_URL` to a Postgres connection string and the app switches to database persistence for libraries, settings, and history. Run migrations once before starting:

```bash
DATABASE_URL=postgres://user:pass@host:5432/db npm run db:migrate
DATABASE_URL=postgres://user:pass@host:5432/db npm start
```

**First-run import:** On the first startup with a database, if the `libraries` table is empty, any `libraries/*.json` files (or a legacy `library.json`) are automatically imported. Subsequent restarts skip the import.

**Migrations are idempotent** — safe to re-run. Each `.sql` file in `db/migrations/` is applied exactly once and tracked in `schema_migrations`.

**Backup:**
```bash
pg_dump "$DATABASE_URL" > quiz-a-roo-$(date +%F).sql
```

### Local Postgres with Docker Compose

```bash
docker compose up --build
# app available at http://localhost:3000
```

This builds the app image, starts a `postgres:16-alpine` container, waits for it to be healthy, runs migrations, then starts the app. Data is stored in a named volume (`postgres-data`).

### Kubernetes / Helm

**File-mode (no DB):**
```bash
helm upgrade --install quiz-a-roo ./charts/quiz-a-roo
```

**Built-in Postgres StatefulSet (dev/staging):**
```yaml
# values override
database:
  enabled: true
postgresql:
  enabled: true
  auth:
    password: "a-real-password"
```
```bash
helm upgrade --install quiz-a-roo ./charts/quiz-a-roo -f my-values.yaml
```

**External Postgres via Secret (production):**
```bash
kubectl create secret generic quiz-a-roo-db \
  --from-literal=DATABASE_URL='postgres://user:pass@your-pg-host:5432/quizaroo'

helm upgrade --install quiz-a-roo ./charts/quiz-a-roo \
  --set database.enabled=true \
  --set database.existingSecret=quiz-a-roo-db \
  --set postgresql.enabled=false
```

When `database.enabled=true` the Helm chart injects `DATABASE_URL` into the app container and runs `npm run db:migrate` in an init-container before the app starts.

### API keys security note

API keys entered through the `/settings` page are saved to `config.json` on the server filesystem. For production Kubernetes deployments, prefer supplying them as environment variables via a Secret:

```bash
kubectl create secret generic quiz-a-roo-keys \
  --from-literal=ANTHROPIC_API_KEY='sk-ant-...' \
  --from-literal=ELEVENLABS_API_KEY='...'
```

Then in `values.yaml`:
```yaml
extraEnvFrom:
  - secretRef:
      name: quiz-a-roo-keys
```

Environment variables take precedence over values stored in `config.json`.

## Tech Stack

- Node.js + Express
- Socket.io (real-time multiplayer)
- Vanilla JS / HTML / CSS (no frontend framework)
- Anthropic API (AI question generation)
- PostgreSQL (optional; `pg` driver)
