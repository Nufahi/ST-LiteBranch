# LiteBranch for SillyTavern

Spin off a small, **fast** chat from a huge one. Big roleplay chats (tens of
MB) lag hard — even when only a few messages are shown — because the whole
chat lives in memory and gets rewritten to disk on every message. LiteBranch
creates a brand-new chat that keeps only the **last N messages**, counting back
from the message you pick, so you can keep going without the lag.

Creating a branch never removes messages from the original chat. Pinning does store stable message IDs and pin metadata in that chat.

## Features

- **Branch from any message.** Every message gets a distinctive split-arrow
  button in its button row. It builds a new chat from that
  message backwards.
- **Pin messages.** Pin any number of messages and use the compact bar above
  the chat to jump between them. Old messages are loaded automatically when
  needed, and pins stay attached when surrounding messages move or are deleted.
- **Floating message actions.** Open the native controls for the last or
  second-to-last message from a floating button next to the jump-down arrow,
  including the editor and the `⋯` menu with extension actions. The panel uses
  theme colors with its own protected layout and compact, touch-sized controls
  on phones.
- **Pick how many messages** to carry over — a dialog with a live preview
  ("will copy messages #120–#170"), pre-filled from your default (50).
- **One-click mode.** Turn off the dialog in settings and the button branches
  instantly using your default count.
- **Optional AI summary.** Summarize the recent tail or process all omitted
  history chronologically in stages. Choose the character budget per request,
  see message coverage and request count, and optionally preview/edit the final
  recap before saving. The recap becomes the first message with a navigation pin.
- **Lorebooks.** Use SillyTavern's native World Info activation during summary
  generation, enabled by default. Uses matching entries and configured budgets.
- **Return to source.** A button above the chat opens the immediate parent of
  the current branch, in both solo and group chats.
- **Slash command** `/litebranch` for Quick Replies and automation.
- **English / Русский** UI (follows SillyTavern's language setting).
- **Group chats.** Branching, summaries, pinning and navigation work in group
  chats too. A branch is added to the same group's chat history, preserving
  message authors, avatars and group settings.

## Usage

- **Button:** open a message's button row and tap the branch icon. The branch
  goes back `N` messages from that one, then opens automatically.
- **Pins:** tap the thumbtack in a message's button row. Use the bar above the
  chat to move between pins, jump to one, or remove it.
- **Floating actions:** tap the floating pen button in the bottom-right of the
  chat and select **Last message** or **Second-to-last message**. Use `⋯` for
  clipboard copy and extension actions; use the pencil for the native editor
  with save, cancel, duplicate, delete, and move controls. Close the panel with
  `×`, Escape, or a click outside it. It closes if its target changes, so an
  already-open menu never silently switches to a different message.
  Drag the small pencil icon with a finger or mouse to place it anywhere on screen; its
  position is remembered on this device and stays within reach after resizing.
- **Slash command:**
  - `/litebranch` — last N (your default) from the last message.
  - `/litebranch 80` — last 80 messages.
  - `/litebranch 80 mes=150` — 80 messages ending at message #150.
  - `/litebranch 80 summary=on` — also add an AI summary of the older part.
- **Settings:** **Extensions → LiteBranch** — default count, dialog on/off,
  floating actions and jump-down buttons, summary defaults/prompt/limit, and
  the branch name template.

## How it works

The branch is saved as a new chat file via SillyTavern's `POST /api/chats/save`
for solo chats or `POST /api/chats/group/save` for groups, containing only the
sliced messages (plus an optional summary as the first message). Metadata links
back to the source chat (`main_chat`). Group branches are registered in the
existing group's history before `openGroupChat` opens them; solo branches use
`openCharacterChat`. Both legacy group metadata and the newer JSONL header
format are supported. Reducing the file size reduces the work required to
render and save it; the improvement depends on message sizes and other extensions.

### Summary workflow

Enable the summary in the branch dialog or extension defaults:

1. **Recent omitted history:** one request, taking the latest text that fits the
   budget (12,000 characters by default). Coverage shows included messages,
   partially included messages, messages outside the budget, and skipped
   hidden/system/empty messages.
2. **All omitted history — in stages:** split older history into chronological
   chunks of the chosen character size. Each request updates the previous recap
   with the next chunk. Oversized messages are split too. A progress indicator
   shows the current stage; cancel stops after the in-flight request completes.
3. **Preview:** optional, off by default. Review and edit the final recap, then
   confirm creation. Cancelling the preview saves no branch. Generation errors
   also stop creation rather than silently making a branch without its recap.
4. **Lorebooks and Author's Note:** passed through the native `skipWIAN` option.
   World Info activation follows the `quiet` trigger, keys and budgets, not a
   full export of every book. The exact scope of `skipWIAN` depends on the ST
   version; it is not an isolation switch for all other prompt context.

Choices in the branch dialog apply to that branch. Extension settings save the
defaults, also used by `/litebranch`. The default recap follows the transcript's
language; customize the prompt to request another language or structure.

## Limitations

- The AI summary uses your current connection/preset via `generateQuietPrompt`.
- The character budget controls transcript text per request, not total model
  context or tokens. Instructions, the previous recap, lorebooks and native
  SillyTavern prompt context are additional. Choose a budget that fits your model.
- Coverage measures text submitted for summarization, not facts guaranteed to
  survive model compression or provider truncation. Staged mode processes all
  eligible older messages but remains a lossy summary, requiring multiple requests.
- Pins are navigation bookmarks and do not keep messages in model context forever.
- Returning to a deleted or renamed source chat requires opening it manually.
- Group branches share their group's members and settings. They are separate
  conversations, not independent copies of the group configuration.

## Development checks

Modules: `index.js` (entry point), `ui.js` (interface and event lifecycle),
`branch.js` (chat storage and navigation), `summary.js` (planning, generation,
preview), `settings.js` (defaults and migration). No build step is needed.

Run `npm test` or `node --test tests/*.test.cjs` (Node.js 18+).
The regression tests simulate SillyTavern's context and HTTP APIs; UI and live
model behavior still need a smoke test in SillyTavern.
