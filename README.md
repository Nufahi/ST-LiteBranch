# LiteBranch for SillyTavern

Spin off a small, **fast** chat from a huge one. Big roleplay chats (tens of
MB) lag hard — even when only a few messages are shown — because the whole
chat lives in memory and gets rewritten to disk on every message. LiteBranch
creates a brand-new chat that keeps only the **last N messages**, counting back
from the message you pick, so you can keep going without the lag.

Your original chat is **never modified** — treat it as your full archive.

## Features

- **Branch from any message.** Every message gets a branch button
  (🜲 `fa-code-branch`) in its button row. It builds a new chat from that
  message backwards.
- **Pick how many messages** to carry over — a dialog with a live preview
  ("will copy messages #120–#170"), pre-filled from your default (50).
- **One-click mode.** Turn off the dialog in settings and the button branches
  instantly using your default count.
- **Optional AI summary.** Ask the model to summarize everything *before* the
  carried-over messages; the recap is pinned as the first message of the branch
  so context isn't lost. Off by default; prompt and history limit are
  configurable.
- **Slash command** `/litebranch` for Quick Replies and automation.
- **English / Русский** UI (follows SillyTavern's language setting).

## Usage

- **Button:** open a message's button row and tap the branch icon. The branch
  goes back `N` messages from that one, then opens automatically.
- **Slash command:**
  - `/litebranch` — last N (your default) from the last message.
  - `/litebranch 80` — last 80 messages.
  - `/litebranch 80 mes=150` — 80 messages ending at message #150.
  - `/litebranch 80 summary=on` — also add an AI summary of the older part.
- **Settings:** **Extensions → LiteBranch** — default count, dialog on/off,
  summary defaults/prompt/limit, and the branch name template.

## How it works

The branch is saved as a new chat file for the current character via
SillyTavern's `POST /api/chats/save`, containing only the sliced messages
(plus an optional summary as the first message). Metadata links back to the
source chat (`main_chat`). Then `openCharacterChat` switches you into it.
Because the new file is a few hundred KB instead of tens of MB, rendering and
saving become instant again.

## Limitations

- **Solo (single-character) chats only.** Group chats show a notice and are
  skipped for now.
- The AI summary uses your current connection/preset via `generateQuietPrompt`.
