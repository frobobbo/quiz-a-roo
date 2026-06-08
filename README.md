# Quiz-a-Roo

A Jeopardy-style multiplayer trivia game for trivia nights. One host runs the game from a laptop, players join on their phones, and the game board displays on a TV.

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

## Features

- **Two rounds** with Daily Doubles and Final Jeopardy
- **Team mode** — players create and join teams with shared scoring
- **AI question generation** — generate full categories or individual questions via the Anthropic API
- **Custom question library** — add, edit, import, and export categories and questions
- **7 color themes** plus a custom colorway picker
- **Sound effects** via Web Audio API (no audio files required)
- **Game history** — results saved locally and viewable from the host panel
- **Tiebreaker round** automatically triggered when players are tied at game end

## Tech Stack

- Node.js + Express
- Socket.io (real-time multiplayer)
- Vanilla JS / HTML / CSS (no frontend framework)
- Anthropic API (AI question generation)
