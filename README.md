<p align="center">
  <img src="web/favicon-256.png" alt="ismini" width="96" height="96">
</p>
<p align="center">
  <img src="web/2.jpeg" alt="ismini in action" width="540" style="border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);">
</p>

<h1 align="center">ismini</h1>
<p align="center">
  <strong>Your personal AI agent, running 100% locally on your Linux PC.</strong><br>
  <em>Current version: v17.0.0</em>
</p>

ismini is a standalone, zero-dependency AI agent that runs entirely on your own machine. Powered by a built-in llama.cpp backend (with Vulkan GPU acceleration and CPU fallback), it requires no external servers, no cloud APIs, and no accounts.

Just download, run, pick a model from the built-in Model Manager, and start chatting.

## ✨ The v16 Era: Standalone & Self-Contained

With the release of v16, ismini is no longer just a frontend for LM Studio. It is now a complete, self-contained AI runtime.

- **Built-in Model Manager:** Browse, download, and manage official models (Qwen, Llama, Gemma, Mistral, etc.) directly from HuggingFace inside the app.
- **Zero-Config Backend:** The `llama.cpp` server starts automatically, handles model switching, and optimizes for your hardware (GPU/CPU) behind the scenes.
- **Newcomer Friendly:** Smart defaults (like auto-selecting Q4_K_M quantizations) and a beautiful side-by-side UI make downloading your first 4GB model as easy as installing a mobile app.

## 🆕 What's new in v17.0.0

- 🎛️ **Context length in the top bar** — click the `ctx` chip to change it (16k → 256k). No more hidden Settings menu. The default is 16k (safe for every box). Raise it if your hardware can handle more. Simple, visible, yours.
- 🎛️ **Manual context length** — no more auto-detection. You set it, ismini uses it. If your box can't afford it, lower it.
- 🎙️ **Cleaner TTS** — ismini no longer reads asterisks, flag emojis, or other symbols aloud. Just clean text.
- 🖱️ **Settings popup never hides** — the ⚙️ menu now flips above or to the side when there's not enough room, so it's always fully visible.
- ⚙️ **Tuned llama.cpp backend** — single prediction slot (`-np 1`) for lower latency, unified KV cache explicitly enabled. All other sampling and memory settings remain at llama.cpp defaults.

## 🆕 What's new in v16.1.1

- 🎯 **Sharper agent behavior** — the built-in system prompt was refined (prompt-only, no code change): ismini now stays quiet when there's nothing actionable, stops over-calling tools and narrating its steps, and uses the right memory tool for the job.
- 🧭 **Smarter memory** — the agent now clearly separates saved facts (`memory`) from the conversation archive (`recall`), so "what did we do before?" is answered by searching past sessions instead of saved notes.
- 🛡️ **Clearer safety** — read-only commands just run; destructive or `sudo` actions outside your home folder state exactly what they'll do and wait for your go-ahead.
- 📉 **Leaner output** — ismini prefers the smallest command that answers the question (bounded `head`/`grep`) instead of dumping whole logs.

## 🆕 What's new in v16.1

- ⚡ **Always fast** — ismini no longer wastes time on hidden "thinking" before answering. Replies come straight out, with no silent delay.
- 🧠 **Adaptive context** — the conversation window is now sized to *your* machine's RAM and the loaded model, so long chats with lots of tool calls no longer overflow or crash — and models load quicker. You can see your active context in a small chip in the header (e.g. `32k ctx`).
- 🔄 **Safe in-place updates** — update ismini right from the app (or reinstall over it) without losing your chat history, memory, models, or settings.
- 📈 **Unlimited session history** — every past conversation is kept, with per-session delete and "clear all."

## 🚀 What it can do

- 💬 **Chat in your browser** — A beautiful, responsive Web UI with streaming text and markdown support.
- 🤖 **Model Manager** — Download official GGUF models directly from HuggingFace with pause/resume/cancel support. Every model shows its size and description.
- 🔁 **Switch models on the fly** — Change models mid-conversation from the header list. ismini also auto-detects models you already have in LM Studio and adds them to the list.
- ❓ **Help & Shortcuts** — A built-in help modal documents every button, feature, and keyboard shortcut (plus how to uninstall).
- 📄 **File Operations** — Read, write, edit, and delete files on your PC (with strict sandboxing and binary file detection).
- ⚙️ **Shell Access** — Run shell commands securely (with optional `sudo` toggling and a dangerous-command blocklist).
- 🔎 **Web Browsing** — Search the web (DuckDuckGo) and fetch/read web pages to answer questions with up-to-date info.
- 🧠 **Persistent Memory** — ismini remembers facts, preferences, and context across sessions in a local `memory.json` file.
- 🖼️ **Vision Support** — Attach images (JPEG, PNG, WebP, GIF) for analysis if you download a Vision-Language Model (VLM).
- 🎙️ **Voice Interaction** — Dictation (STT), Text-to-Speech (TTS), and a continuous "Live Chat" mode for hands-free conversation.
- 🎨 **Beautiful Themes** — Choose between Papyrus (ancient scroll), Stars (night sky), or Marble (black marble).
- 🏛️ **Greek Meander** — A classic thunder-pattern frames the interface, giving it a unique, scholarly aesthetic.

## 🛡️ Privacy & Security

- **100% Local:** Your chats, memories, and downloaded models never leave your PC.
- **Sandboxed Tools:** File operations are restricted to your home directory and workspace. Sensitive paths (`.ssh`, `.gnupg`, `/etc/passwd`) are strictly blocked.
- **Network Isolation:** The web server binds to `127.0.0.1` only. Nobody else on your local network can access it.
- **Confirmation Prompts:** Destructive actions (writing files, running privileged commands) require explicit user approval via a UI prompt.

## 📦 What you need

- A Linux computer (Ubuntu, Mint, Fedora, Arch, etc.).
- **Node.js 18+** — [Download here](https://nodejs.org/) or install via your package manager (`sudo apt install nodejs`).
- A modern browser — **Microsoft Edge** is recommended (best Text-to-Speech voices), with **Google Chrome** as the alternative. ismini picks one automatically, preferring Edge.
- *(Optional)* A GPU with Vulkan support for fast inference. If no GPU is found, ismini will gracefully fall back to your CPU.

## ⚡ Setup (2 minutes)

1. Download the Source code (zip) from the [latest release](https://github.com/tasosdelotas/ismini-linux/releases/latest).
2. Extract the zip file.
3. Double-click `install.sh` (or run `./install.sh` in a terminal).
4. Done! An ismini icon will appear on your desktop and in your app menu.

## 🎮 Using it

1. Click the ismini desktop icon.
2. Your browser will open to `http://127.0.0.1:8787`.
3. Click the **🤖 Models** button in the header.
4. Pick a model (e.g., Qwen2.5-7B-Instruct) and click **Download**.
5. Once downloaded, ismini will auto-start the backend. Just type "hi" and start working!

### Useful Buttons

| Button | What it does |
|---|---|
| 🤖 Models | Opens the Model Manager to download AI models (each shows its size + description) |
| ❓ Help | Opens the Help & Shortcuts modal (features, buttons, keys, uninstall) |
| sudo: ON/OFF | Toggles privileged command execution |
| Sessions | Switch between your current and archived conversations, **delete** any one (✕), or **clear all** |
| 📄 / 📁 | Opens a native file/folder picker to insert paths into the chat |
| 🖼️ | Attach an image for the AI to analyze (requires a Vision model) |
| ⏸ Pause | Abort the AI mid-generation and redirect it |
| 🎙 Mic | Toggle voice dictation (Speech-to-Text) |
| 🔊 TTS | Toggle Text-to-Speech (the AI reads its replies aloud) |
| Live | Enter continuous voice-conversation mode |

### Keyboard shortcuts

| Keys | Action |
|---|---|
| `Enter` | Send the message |
| `Shift + Enter` | Add a new line in the message box |
| `Escape` | Close an open window (Models, Help, popovers) |

## 🧠 Memory & Sessions

- **Memory:** Ask ismini to "remember this", and it saves it to `memory.json`. It will recall these facts in future sessions.
- **Sessions:** ismini keeps an **unlimited archive** of your past conversations. Open the **Sessions** menu to switch back to any of them, **delete** a specific one (✕), or **clear all** at once. Click "New chat" to archive the current thread and start fresh. (Each session is capped at 500 messages to keep storage lean.)
- **Recall:** ismini can **search all past sessions** on its own. Ask things like *"what did we decide last time about X?"* or *"did we already fix the icon bug?"* and it will look up the relevant earlier conversation and bring it into the current one.

## 🔄 Uninstall & Upgrade

- **Uninstall:** Run `./uninstall.sh`. It will safely stop the server and remove the app, desktop icons, and temporary files. *(Note: This will also delete your downloaded models and chat history. Back them up first if needed!)*
- **Upgrade:** Simply download the new release and run its `install.sh`. It will automatically stop the running app, preserve your `config.json`, `sessions.json`, and `memory.json`, and merge any new default tools into your config.

## 🛠️ How it works (Under the Hood)

- **Backend:** A custom `llama-backend.js` module spawns and manages the `llama-server` process, handling model loading, unloading, and health checks.
- **Agent Loop:** `agent.js` handles the ReAct (Reason + Act) loop, streaming tokens, parsing tool calls, and enforcing context-window limits.
- **Web UI:** A zero-dependency Node.js HTTP server (`web.js`) serves the frontend and handles Server-Sent Events (SSE) for real-time streaming.
- **Zero npm packages:** The entire app relies only on Node.js built-in modules (`http`, `fs`, `child_process`, `crypto`, etc.).

## 👤 Author & License

Developed with ❤️ by Tasos Delotas — [tasosdelotas@gmail.com](mailto:tasosdelotas@gmail.com)

The app is licensed under the [MIT License](LICENSE).  
The bundled Cinzel font is licensed under the SIL Open Font License 1.1 (see `web/fonts/OFL.txt`).  
Model weights downloaded via the Model Manager are subject to their respective licenses on HuggingFace (e.g., Apache 2.0, Llama 3 Community License).