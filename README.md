<p align="center">
  <img src="web/favicon-256.png" alt="ismini" width="96" height="96">
</p>

<p align="center">
  <img src="2.jpeg" alt="ismini in action" width="480">
</p>

# ismini — your personal AI agent, powered locally on your PC

**Current version: v11.0.4**

ismini is a small, friendly AI assistant that runs on your computer and uses a local AI model in LM Studio by default. It chats with you in your browser, and can read and write files, run commands, and search the web. No cloud AI account or sign-up is required.

## Privacy

The app and its default LM Studio connection run locally. Chat sessions (`sessions.json`) and long-term memory (`memory.json`) are stored only as local files in the ismini folder. Network features do contact external services: **web search sends your query to DuckDuckGo**, and **web fetch connects to the URL you ask it to read**. Dictation and text-to-speech use your browser's speech features; depending on the browser and selected voice, speech processing or voice data may use the browser vendor's services.

HTTP responses include basic security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`). The server binds to `127.0.0.1` only and validates request origins, so it is unreachable from other devices on the network.

## What it can do

- 💬 **Chat with an AI** in your browser — the AI is a model you run locally in LM Studio
- 📄 **Read, write, edit, and delete files** on your PC (binary files like PDFs and archives are detected and handled gracefully)
- ⚙️ **Run shell commands** (with optional sudo)
- 🔎 **Search the web** and read web pages
- ⏸️ **Pause & redirect** — stop it mid-task and tell it what to do instead
- 🖱️ **File & folder buttons** — click 📄 or 📁 and pick a file from your desktop; its path goes into the chat
- 🖼️ **Image understanding** — attach JPEG, PNG, WebP, or GIF images (up to 4 MiB) for analysis with a vision-capable LM Studio model
- 🎙️ **Dictation** — click the mic and speak your message; speech-to-text via Web Speech API
- 🔊 **Text-to-Speech (TTS)** — ismini reads its replies aloud; pick your preferred voice
- 🎧 **Live Chat** — continuous voice conversation: speak, ismini listens, responds with voice, and immediately listens again
- 🧠 **Memory** — ismini remembers facts across sessions (persistent memory file)
- 📋 **Sessions** — switch between your current and up to 3 archived conversations
- 🤖 **Model switching** — switch between any LM Studio model on-the-fly using the dropdown menu; ismini automatically adapts context window and capabilities
- 🎨 **Three themes** — **Papyrus** (an ancient scroll), **Stars** (a twinkling night sky), or **Marble** (black marble) — pick one in the header and ismini remembers your choice
- 🏛️ **Greek meander border** — a classic thunder-pattern frames the left and right edges of the interface

## What you need

- A **Linux** computer (Ubuntu, Mint, Fedora, etc.)
- **Node.js 18 or newer** — download from [nodejs.org](https://nodejs.org/)
- **LM Studio** with a model loaded — download from [lmstudio.ai](https://lmstudio.ai/)
- A **modern browser** (Edge recommended for the best TTS voices, Chrome also works)

## Setup (2 minutes)

1. Download the **Source code (zip)** from the [latest ismini-linux release](https://github.com/tasosdelotas/ismini-linux/releases/latest)
2. Right-click the zip → **Extract Here**
3. In the extracted folder, **double-click `install.sh`** (or run `./install.sh` in a terminal)

Done! An **ismini** icon appears on your desktop. Click it to start.

## Using it

1. Make sure **LM Studio is open** with a model loaded (any model works — ismini detects it automatically)
2. Click the **ismini desktop icon**
3. Your browser opens at `http://127.0.0.1:8787` — just start chatting

**Useful buttons:**

| Button | What it does |
|--------|--------------|
| **sudo: ON/OFF** | Allow (ON) or block (OFF) privileged commands |
| **New chat** | Archive current session and start fresh |
| **Sessions** | Dropdown to switch between current + 3 archived sessions |
| **📄 / 📁** | Pick a file or folder — its path is inserted into the chat |
| **🖼️** | Attach a JPEG, PNG, WebP, or GIF image (up to 4 MiB) |
| **Pause** | Stop the agent mid-task and redirect it |
| **🎙 Mic** | Toggle dictation — speak your message instead of typing |
| **TTS / Muted** | Toggle text-to-speech — ismini reads replies aloud |
| **Voice select** | Choose which voice ismini speaks with |
| **Live** | Toggle continuous voice conversation mode |
| **Papyrus / Stars / Marble** | Switch the look — ancient scroll, night sky, or black marble |

### Dictation (Speech-to-Text)

Click the **🎙** mic button in the input area. Your microphone activates (red = off, green blinking = listening). Speak your message and it appears as text in the input box. Click the mic again to stop. Works with Chrome and Edge.

### Text-to-Speech (TTS)

Click the **TTS** button to enable. ismini will read its replies aloud using your browser's speech synthesis. Use the voice dropdown to pick a different voice. Click **Muted** to turn it off.

### Live Chat

Click the **Live** button to start a continuous voice conversation. ismini will:
1. Listen to you (mic opens)
2. Think and respond
3. Speak the reply aloud (TTS)
4. Immediately listen again

The Live button shows: **red** (off), **green blinking** (active), **purple** (speaking). Click again to stop.

### Memory

ismini has a tiny local long-term memory file (`memory.json`). Ask it to remember a stable fact or preference, and it saves it with `memory_add`. In later sessions it can find relevant memories with `memory_search`, or remove them with `memory_delete`.

Memory is local, dependency-free, and on-demand: it does not add background processing or slow normal chat. Never ask it to store passwords, tokens, secrets, keys, or credentials.

### Sessions

ismini keeps your current session plus up to 3 archived ones. Click **New chat** to archive the current and start fresh. Click **Sessions** to see the list and switch back to any archived conversation. Sessions are labeled by date and time.

### Image understanding

Use the **🖼️** button beside the message box to attach a JPEG, PNG, WebP, or GIF image (up to 4 MiB), then send it with your question. Image understanding requires a vision-capable model loaded in LM Studio. The image is sent to your configured model endpoint (local by default) and retained in local session history.

## Uninstall

Double-click `uninstall.sh` (or run `./uninstall.sh`). It removes the installed app at `~/ismini` and its desktop icon, even when you run the script from the downloaded source folder. The source folder, your LM Studio, and your other files are left untouched.

To upgrade, run the newer source folder's `install.sh` again. It stops the running app before replacing program files, preserves your `config.json`, `sessions.json`, and `memory.json`, and refuses to overwrite files if it cannot stop the app.

## How it works (the short version)

- One small web server (`web.js`) + one agent loop (`agent.js`) + a browser chat page, with tiny local stores for sessions and memory
- Talks to LM Studio's local API — whatever model you have loaded, it uses
- Zero npm packages — only Node.js built-ins
- All visuals are local files (papyrus, starfield, marble, meander border, the Cinzel font) — no CDNs, no internet needed for the UI
- Binds to `127.0.0.1` only — nobody else on the network can reach it
- **The sudo toggle is the safety switch.** With it **ON**, everything runs hands-off — no per-command approvals (dangerous commands are still silently blocked). With it **OFF**, ismini asks before each exec/write/edit/delete so a normal-user session stays in control. Read and web tools never prompt.
- A blocklist stops the most obviously destructive shell commands (disk wipes, root-level `rm -rf`, fork bombs) — a best-effort guard against accidents, not a security boundary. The real protections are the confirmation prompt above and running as your normal user by default
- Process cleanup uses graceful shutdown (SIGTERM → 2s grace → SIGKILL) so running commands get a chance to finish cleanly
- Dictation, TTS, and Live Chat use the browser's built-in Web Speech API — no extra services

## Author & License

Developed by **Tasos Delotas** — [tasosdelotas@gmail.com](mailto:tasosdelotas@gmail.com)

The app is licensed under the [MIT License](LICENSE). The bundled Cinzel font is separately licensed under the SIL Open Font License 1.1; see [`web/fonts/OFL.txt`](web/fonts/OFL.txt).
