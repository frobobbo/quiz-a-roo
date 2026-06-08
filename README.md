# Quiz-a-Roo

A Jeopardy-style multiplayer trivia game for trivia nights. One host runs the game from a laptop, players join on their phones, and the game board displays on a TV.

## Setup

```bash
npm install
```

Create a `config.json` file in the project root:

```json
{
  "ANTHROPIC_API_KEY": "your-api-key-here"
}
```

## Running

```bash
npm start
```

The server runs on **port 3000**.

## Screens

| URL | Device | Purpose |
|-----|--------|---------|
| `/board` | TV / projector | Game board display |
| `/host` | Host laptop | Game control panel |
| `/player` | Player phones | Buzz in + wager |

Players scan a QR code on the board screen to join. The host login PIN is `2653`.

## Features

- **Two rounds** with Daily Doubles and Final Jeopardy
- **Team mode** — players can create and join teams with shared scoring
- **Custom question library** — add your own categories and questions
- **7 color themes** plus a custom colorway picker
- **Sound effects** via Web Audio API (no audio files required)
- **Game history** — results saved locally and viewable from the host panel
- **Tiebreaker round** automatically triggered when players are tied at game end

## Tech Stack

- Node.js + Express
- Socket.io (real-time multiplayer)
- Vanilla JS / HTML / CSS (no frontend framework)
- Anthropic API (question generation)
