<p align="center">
  <img src="web/favicon-256.png" alt="ismini" width="96" height="96">
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
- 🎨 **Three themes** — **Papyrus** (an ancient scroll), **Stars** (a twinkling night sky), or **Marble** (black marble) — pick one in the header and ismini remembers your choice

## What you need

- A **Linux** computer (Ubuntu, Mint, Fedora, etc.)
- **Node.js 18 or newer** — download from [nodejs.org](https://nodejs.org/)
- **LM Studio** with a model loaded — download from [lmstudio.ai](https://lmstudio.ai/)

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
| **New chat** | Start a fresh conversation |
| **📄 / 📁** | Pick a file or folder — its path is inserted into the chat |
| **Pause** | Stop the agent mid-task and redirect it |
| **Papyrus / Stars / Marble** | Switch the look — ancient scroll, night sky, or black marble. Your choice is remembered |

## Uninstall

Double-click `uninstall.sh` (or run `./uninstall.sh`). It removes the app, the desktop icon, and the config — your LM Studio and your files are untouched.

## How it works (the short version)

- One small web server (`web.js`) + one agent loop (`agent.js`) + a browser chat page
- Talks to LM Studio's local API — whatever model you have loaded, it uses
- Zero npm packages — only Node.js built-ins
- All visuals are local files (papyrus, starfield, marble, the Cinzel font) — no CDNs, no internet needed for the UI
- Binds to `127.0.0.1` only — nobody else on the network can reach it

## Author & License

Developed by **Tasos Delotas** — [tasosdelotas@gmail.com](mailto:tasosdelotas@gmail.com)

Licensed under the [MIT License](LICENSE).
