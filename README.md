<p align="center">
  <img src="web/favicon-256.png" alt="ismini" width="96" height="96">
</p>

<p align="center">
  <img src="2.jpeg" alt="ismini in action" width="480">
</p>

# ismini — your personal AI agent, 100% on your own PC

ismini is a small, friendly AI assistant that runs entirely on your computer. It chats with you in your browser, and can read and write files, run commands, and search the web — all powered by a local AI model (LM Studio). No cloud, no accounts, no sign-ups. Your data never leaves your machine.

## What it can do

- 💬 **Chat with an AI** in your browser — the AI is a model you run locally in LM Studio
- 📄 **Read, write, edit, and delete files** on your PC
- ⚙️ **Run shell commands** (with optional sudo)
- 🔎 **Search the web** and read web pages
- ⏸️ **Pause & redirect** — stop it mid-task and tell it what to do instead
- 🖱️ **File & folder buttons** — click 📄 or 📁 and pick a file from your desktop; its path goes into the chat
- 🎙️ **Dictation** — click the mic and speak your message; speech-to-text via Web Speech API
- 🔊 **Text-to-Speech (TTS)** — ismini reads its replies aloud; pick your preferred voice
- 🎧 **Live Chat** — continuous voice conversation: speak, ismini listens, responds with voice, and immediately listens again
- 🧠 **Memory** — ismini remembers facts across sessions (persistent memory file)
- 📋 **Sessions** — switch between your current and up to 3 archived conversations
- 🎨 **Three themes** — **Papyrus** (an ancient scroll), **Stars** (a twinkling night sky), or **Marble** (black marble) — pick one in the header and ismini remembers your choice

## What you need

- A **Linux** computer (Ubuntu, Mint, Fedora, etc.)
- **Node.js 18 or newer** — download from [nodejs.org](https://nodejs.org/)
- **LM Studio** with a model loaded — download from [lmstudio.ai](https://lmstudio.ai/)
- A **modern browser** (Chrome/Edge recommended for dictation, TTS, and Live Chat)

## Setup (2 minutes)

1. Download the **Source code (zip)** from the [Releases page](https://github.com/tasosdelotas/ismini/releases)
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

ismini has a persistent memory file (`memory.json`) that stores facts and context across sessions. Ask it to remember something and it will save it. It will recall relevant memories in future conversations.

### Sessions

ismini keeps your current session plus up to 3 archived ones. Click **New chat** to archive the current and start fresh. Click **Sessions** to see the list and switch back to any archived conversation. Sessions are labeled by date and time.

## Uninstall

Double-click `uninstall.sh` (or run `./uninstall.sh`). It removes the app, the desktop icon, and the config — your LM Studio and your files are untouched.

## How it works (the short version)

- One small web server (`web.js`) + one agent loop (`agent.js`) + a browser chat page
- Talks to LM Studio's local API — whatever model you have loaded, it uses
- Zero npm packages — only Node.js built-ins
- All visuals are local files (papyrus, starfield, marble, the Cinzel font) — no CDNs, no internet needed for the UI
- Binds to `127.0.0.1` only — nobody else on the network can reach it
- Dictation, TTS, and Live Chat use the browser's built-in Web Speech API — no extra services

## Author & License

Developed by **Tasos Delotas** — [tasosdelotas@gmail.com](mailto:tasosdelotas@gmail.com)

Licensed under the [MIT License](LICENSE).
