# Blink — disappearing-snap chat app (web, phone-first)

Add friends by **username**, chat, and send **photos or videos that can be opened only once** — full-screen, with a timer bar and caption, like a snap. Installable on your phone's home screen.

The app is plain HTML/CSS/JS (no build step), so it can be hosted **free on GitHub Pages**. Sharing messages between phones needs a small free backend: **Supabase** (accounts, database, file storage, realtime).

| Mode | When | What you get |
|---|---|---|
| **Demo** | `js/config.js` left empty | Works instantly, data stays in your browser. 3 bot friends (mia, leo, zoe) reply to you. |
| **Real** | Supabase URL + key filled in | Real accounts. Chat with real friends on their own phones. |

---

## 1 · Set up the backend (Supabase, free, ~5 min)

1. Create a free account at <https://supabase.com> → **New project** (pick any name/password/region).
2. Open **SQL Editor → New query**, paste the whole contents of `schema.sql`, press **Run**. (Run it once; you should see “Success”.)
3. Go to **Authentication → Sign In / Providers → Email** and **turn OFF “Confirm email”**. (Otherwise sign-up waits for an email that Supabase’s free mailer rarely delivers.)
4. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key.
5. Open `js/config.js` and paste them in:
   ```js
   export const CONFIG = {
     SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
     SUPABASE_ANON_KEY: 'eyJhbGciOi…',
   };
   ```
   The anon key is *meant* to be public — the security rules in `schema.sql` protect the data. **Never** paste the `service_role` key anywhere.

## 2 · Put it online with GitHub Pages (free)

1. Create a GitHub account → **New repository** → name it e.g. `blink` → set it to **Public** → Create.
2. Click **uploading an existing file**, then drag in **everything inside this folder** (`index.html`, `css/`, `js/`, `icons/`, `manifest.webmanifest`, `sw.js` …). Commit.
3. Repo **Settings → Pages → Build and deployment**: Source = **Deploy from a branch**, Branch = **main** / **(root)** → Save.
4. After ~1 minute your app is live at `https://YOUR-USERNAME.github.io/blink/`.

(Prefer something else? Any static host works: Cloudflare Pages, Netlify drag-and-drop, Vercel. Just upload the folder.)

## 3 · Install it on your phone

Open the link on your phone → **iPhone:** Share → *Add to Home Screen* · **Android:** ⋮ → *Install app* / *Add to Home screen*. It opens full-screen like a native app.

Send your friends the link; they sign up, then add each other by username.

---

## How it works

- **Camera tab** – uses your camera's **own format** (same picture as your phone's normal camera — no crop, no zoom). Tap the shutter for a photo, hold it for a video (max 15 s), **double-tap the picture (or press the flip button) to switch cameras — even while recording**, or pick from your gallery. **⚡ Flash button:** on the front camera a white glow frames the screen *before* you shoot, with a vertical **brightness slider** on the side; on the back camera it uses the phone's real flash where the browser allows it (Android Chrome — iPhone Safari doesn't allow it, so use the front camera there).
- **Caption** – tap **Aa**, type, then **drag the text up or down** anywhere on the snap. Your friend sees it at the same spot. Also choose a viewing time (3/5/10 s for photos), then pick who to send to.
- **Snaps** – shown as a coloured tile (pink = photo, purple = video). They can be opened **once**, then they're gone — the file is deleted and the server refuses a second download. Senders see *Delivered → Opened*.
- **Chats list** – tap a chat with a new snap to **open the snap right away** (several snaps play one after another). **Swipe the row to the right** to open the chat *without* opening the snap.
- **Double camera** – tap the new ▭▭ button on the camera to see **front and back at the same time** (stacked, 3:4). Photos and videos are saved the same way. Flip swaps which camera is on top. It stays on until you switch it off. Some phones (and most iPhones) can't open both cameras at once — the app tells you.
- **Chats disappear after 24 hours** – messages, voice messages and snaps are deleted 24 h after they were sent, **unless you save them**. **Tap a message once to save it** (it gets a pink outline, a bookmark and “Saved by you”); tap again to unsave. The person who saved it is the only one who can unsave. Saved snaps (see below) also stay.
- **Voice messages** – hold the 🎤 button (shown when the text box is empty), talk, release to send, slide left to cancel. Up to 60 s. Tap ▶ to play; tap the bubble to save it.
- **Reactions** sit on the corner of the message. **Long-press** a message to see **who reacted with what**.
- **Account** (your avatar at the top of *Chats*, or *Friends → Account*) – change your display name and password, **block** people (by username, or with the ⊘ button in your friends list; unblock any time), pick a **theme** (Midnight, Ocean, Sunset, Forest, Bubblegum, Daylight, Neon) and log out.
- **Reply** – long-press any message or snap → **Reply** (a quote appears above your answer). While watching a snap there's a **Reply…** bar at the bottom.
- **Reactions** – long-press a message or snap → ❤️ 👍 👎 😂 😮 😢 🔥. Tap your reaction again to remove it.
- **Message times** – in a chat, drag the screen sideways a little: the time of every message slides in on the right.
- **Save in chat** – while watching a snap someone sent you, tap **Save in chat** to keep it. You can also long-press the “Opened” tile afterwards and save it — but only for **5 minutes** after opening it (a copy is kept on your phone just for that time). It stays in the chat as a “Saved Photo/Video” tile that you **and** the sender can open again any time.
- **Groups** – Chats tab → the group icon (top right) → name it and pick 2–9 friends. Text chat plus group snaps (each person opens their own copy once). The “⋯” menu in a group lets you leave it; an empty group deletes itself.
- **Friends** – add by username → the other person accepts. Only accepted friends can message each other or be put in a group together.

### Already deployed the first version?
Your Supabase database needs one upgrade for groups, “Save in chat” and caption position:
Supabase → **SQL Editor → New query** → paste `migrations/002_groups_save_caption.sql` (only if you set up the very first version), then `migrations/003_reactions_replies.sql` (replies, reactions, 5-minute save limit), then `migrations/004_voice_save_blocks.sql` (voice messages, tap-to-save, 24 h expiry, blocking), then `migrations/005_stories_avatars.sql` (stories, profile pictures), then `migrations/006_filters_stickers_polls_themes.sql` (filters, stickers, polls, best friends, shared chat backgrounds, “Media” label) → **Run** (once each). Then upload the new app files to GitHub (replace the old ones). Brand-new project? Just run `schema.sql` — it already includes everything.

### New in this version
- **Filters**: in the snap preview tap the wand — 12 looks (Vivid, Warm, B&W, Noir, Vintage…). The filter travels with the snap and its story.
- **Stickers**: on a snap, tap the smiley, pick one, drag it, tap to make it bigger, tap again to remove. In a chat, the smiley next to the message box sends a big sticker.
- **Polls**: in a chat press **+ → Poll**. Everyone in the chat (or group) can vote, change their vote, or tap their answer again to take it back. Hold the poll to see who voted what.
- **Best friends**: tap the star next to a friend (Friends tab or their profile). Up to 8, only you see the list; they get a ★, and “Send to” lists them first with a Select all button.
- **Chat backgrounds**: **+ → Chat background**. 12 looks or your own photo, the same for everyone in that chat. “Default” goes back to your theme.
- **“Media” label**: a photo or video picked from your library (not taken in Blink) shows a **Media** tag in its top-left corner, so people know.
- Earlier this round: **stories**, **profile page** (tap a friend’s name in a chat), **profile pictures**, **15 themes**.
- Chat backgrounds are stored in a public `chatbg` bucket (anyone with the exact link can see it).

### Files
```
index.html            app shell
css/style.css         all styling (dark, mobile-first, safe-area aware)
js/main.js            UI: auth, chats, friends, viewer, preview, send flow
js/camera.js          live camera + photo/video capture
js/extras.js          filters, stickers, polls maker, chat backgrounds
js/account.js         account screen (name, picture, themes, password, blocking)
js/themes.js          the 15 colour themes
js/backend.js         Supabase backend + built-in demo backend
js/config.js          ← put your Supabase URL + key here
schema.sql            database tables + security rules (run once in Supabase)
migrations/           upgrade script for projects created with the first version
sw.js, manifest…      installable-app (PWA) bits
```

## Honest limits

- **24-hour cleanup** happens when either person opens Blink (and every 30 min while it is open): the files are deleted first, then the messages. Expired messages are hidden immediately in the app. If neither of you opens the app, the old rows just sit there, unseen.
- **Blocking** removes the friendship, stops friend requests either way, and hides what the blocked person sends you (including in groups). They are not told. They can still see what *you* sent them earlier.
- Changing your password in live mode asks for your current one first. Themes are remembered **on this device**.

- A web app **cannot block screenshots or screen recording** — nobody can, on the web. “View once” stops re-opening in the app, not copying.
- No push notifications when the app is closed (that needs a push server). New snaps/messages appear live while the app is open.
- Free Supabase tier: 1 GB file storage, 50 MB per file, and a project **pauses after ~1 week without activity** (one click to resume in the dashboard).
- Snaps are uploaded once per recipient so each person’s copy can be deleted independently; if someone never opens a snap, the file stays until it’s opened.
- Snaps keep the original shape of the photo/video. Reactions in groups are only visible to the person who sent the message and the person who reacted.
- iPhone `.mov` videos picked from the gallery may not play on some Android phones; videos recorded in the app are fine.
- A snap that a group member saves is kept for them and the sender only, not for the whole group.
- Browsers only allow the camera on **https** (GitHub Pages is) or `localhost`.

## Try it locally
```bash
cd blink
python3 -m http.server 8000     # then open http://localhost:8000
```
(Opening `index.html` by double-click won’t work — browsers block ES modules from `file://`.)

## Troubleshooting
- **“Account created, but Supabase wants an email confirmation”** → step 1.3: turn off *Confirm email*, then log in.
- **“Email address … is invalid”** → use a real email address.
- **Can’t send to a friend** → you must both have accepted the friend request.
- **Page shows old version after you update files** → close the app fully and reopen (the service worker refreshes on next load).
