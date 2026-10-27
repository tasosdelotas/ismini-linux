<p align="center">
  <img src="web/favicon-256.png" alt="ismini" width="96" height="96">
</p>
<p align="center">
  <img src="web/2.jpeg" alt="ismini in action" width="540" style="border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);">
</p>

<h1 align="center">ismini</h1>
<p align="center">
  <strong>Your personal AI agent, running 100% locally on your Linux PC.</strong><br>
  <em>v17.0.2 — A New Era</em>
</p>

ismini is a standalone, zero-dependency AI agent that runs entirely on your own machine. It has its own built-in llama.cpp backend (Vulkan GPU + CPU), its own bundled Node.js runtime, its own Model Manager, its own memory, its own sessions, its own voice. No cloud. No accounts. No external dependencies. No other apps.

Just download, run, pick a model, and start chatting.

## ✨ What makes ismini different

- **Truly standalone** — ismini bundles everything it needs: Node.js runtime, llama.cpp inference engine, Web UI, agent brain, model manager. One download, one `install.sh`, done.
- **Zero dependencies** — no npm packages, no pip, no docker, no external servers. The entire app relies on Node.js built-in modules.
- **Newcomer friendly** — smart defaults, a beautiful UI, and a Model Manager that makes downloading your first 4 GB model as easy as installing a mobile app.
- **Privacy first** — your chats, memories, and models never leave your PC. The web server binds to `127.0.0.1` only.
- **Fast** — single prediction slot, unified KV cache, no hidden "thinking" overhead. ismini responds before your finger leaves Enter.

## 🚀 What it can do

- 💬 **Chat in your browser** — A beautiful, responsive Web UI with streaming text and markdown support.
- 🤖 **Model Manager** — Download official GGUF models directly from HuggingFace with pause/resume/cancel. Every model shows its size and description.
- 🔁 **Switch models on the fly** — Change models mid-conversation. ismini also auto-detects models you already have in LM Studio.
- 📄 **File Operations** — Read, write, edit, and delete files (with strict sandboxing).
- ⚙️ **Shell Access** — Run shell commands securely (with optional `sudo` and a dangerous-command blocklist).
- 🔎 **Web Browsing** — Search the web (DuckDuckGo) and fetch/read pages.
- 🧠 **Persistent Memory** — ismini remembers facts, preferences, and context across sessions.
- 🗂️ **Unlimited Sessions** — Every past conversation is kept, with per-session delete and "clear all."
- 🔍 **Recall** — ismini can search all past sessions on its own. Ask *"what did we decide last time?"* and it finds it.
- 🖼️ **Vision Support** — Attach images for analysis (requires a Vision-Language Model).
- 🎙️ **Voice** — Dictation (STT), Text-to-Speech (TTS), and a continuous "Live Chat" mode.
- 🎛️ **Context length in the top bar** — click the `ctx` chip to set it (16k → 256k). Simple, visible, yours.
- 🎨 **Beautiful Themes** — Papyrus, Stars, or Marble.
- 🏛️ **Greek Meander** — A classic thunder-pattern frames the interface.

## 📦 What you need

- A Linux computer (Ubuntu, Mint, Fedora, Arch, etc.).
- A modern browser — **Microsoft Edge** is recommended (best Text-to-Speech voices), with **Google Chrome** as the alternative. ismini picks one automatically.
- *(Optional)* A GPU with Vulkan support for fast inference. If no GPU is found, ismini gracefully falls back to your CPU.

**That's it.** No Node.js to install, no npm, no pip, no docker. ismini brings its own runtime.

## ⚡ Setup (2 minutes)

1. Download the source code (zip) from the [latest release](https://github.com/tasosdelotas/ismini-linux/releases/latest).
2. Extract the zip file.
3. Double-click `install.sh` (or run `./install.sh` in a terminal).
4. Done! An ismini icon appears on your desktop and in your app menu.

## 🎮 Using it

1. Click the ismini desktop icon.
2. Your browser opens to `http://127.0.0.1:8787`.
3. Click **🤖 Models** in the header.
4. Pick a model (e.g. Qwen2.5-7B-Instruct) and click **Download**.
5. Once downloaded, ismini auto-starts the backend. Type "hi" and start working!

### Useful Buttons

| Button | What it does |
|---|---|
| 🤖 Models | Opens the Model Manager to download AI models |
| ❓ Help | Opens the Help & Shortcuts modal |
| sudo: ON/OFF | Toggles privileged command execution |
| Sessions | Switch between conversations, delete (✕), or clear all |
| 📄 / 📁 | Opens a native file/folder picker |
| 🖼️ | Attach an image for the AI to analyze |
| ⏸ Pause | Abort the AI mid-generation |
| 🎙 Mic | Toggle voice dictation |
| 🔊 TTS | Toggle Text-to-Speech |
| Live | Continuous voice-conversation mode |
| **N,NNN ctx** | Click to set context length (16k → 256k) |

### Keyboard shortcuts

| Keys | Action |
|---|---|
| `Enter` | Send the message |
| `Shift + Enter` | Add a new line |
| `Escape` | Close an open window |

## 🧠 Memory & Sessions

- **Memory:** Ask ismini to "remember this" and it saves the fact to `memory.json` for future sessions.
- **Sessions:** Unlimited archive. Switch, delete (✕), or clear all.
- **Recall:** ismini searches all past sessions on its own. *"What did we decide last time about X?"*

## 🔄 Uninstall & Upgrade

- **Uninstall:** Run `./uninstall.sh`. Stops the server and removes the app. *(Deletes models and chat history — back up first if needed!)*
- **Upgrade:** Download the new release, run its `install.sh`. Preserves your config, sessions, and memory.

## 🛡️ Privacy & Security

- **100% Local:** Your chats, memories, and models never leave your PC.
- **Sandboxed Tools:** File operations restricted to your home directory. Sensitive paths blocked.
- **Network Isolation:** Binds to `127.0.0.1` only.
- **Confirmation Prompts:** Destructive actions require explicit approval.

## 🛠️ Under the Hood

- **Backend:** `llama-backend.js` manages the built-in `llama-server` (Vulkan + CPU).
- **Agent:** `agent.js` runs the ReAct loop, streams tokens, parses tool calls, enforces context limits.
- **Web UI:** `web.js` — zero-dependency Node.js HTTP server with SSE streaming.
- **Zero npm packages:** Only Node.js built-in modules.
- **Bundled Node.js:** `node/bin/node` — no system Node needed.
- **Bundled llama.cpp:** `llama-cpp/llama-server` + all `.so` libs (build 11901).

## 👤 Author & License

Developed with ❤️ by Tasos Delotas

Licensed under the [MIT License](LICENSE).
The bundled Cinzel font is licensed under SIL Open Font License 1.1.
Model weights are subject to their respective HuggingFace licenses.
