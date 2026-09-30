# easy-study

English · [한국어](README.md)

Study lecture PDFs slide by slide with an LLM tutor. The slides scroll on the left; the chat on the right knows **which
slide you are looking at**. It uses the **Claude Code** (Claude subscription) or **Codex** (ChatGPT subscription) CLI you
are already signed in to, or the Claude / OpenAI API with a key. Record a lecture and it is transcribed on your computer,
split by slide, and the tutor knows what the professor said. Highlight, draw and leave memos on slides; the tutor reads
the memos too.

The app is in Korean and English: **Settings › Display › Language** (Use system setting · 한국어 · English). The language
also sets the tutor's answers, digests, note headings and the default lecture language of new recordings. The desktop
app's menus and dialogs follow the OS language. The full documentation is in Korean ([README.md](README.md)); this page
covers the essentials.

## Install

Download the app for your computer from the [releases page](https://github.com/Wooangha/easy-study-releases/releases/latest):

| OS | File |
|---|---|
| macOS (Apple silicon / Intel) | `easy-study_<version>_aarch64.dmg` / `_x64.dmg` |
| Windows | `easy-study_<version>_x64-setup.exe` |
| Linux | `.deb`, `.rpm`, `.AppImage`, or the Arch package `easy-study-bin` |
| Linux server (no GUI) | `easy-study-server-<version>-linux-<x64\|arm64>.tar.gz` (see below) |

The app updates itself: when a new version is out, a dot appears on the gear and a banner offers to update.

## First steps

1. Choose **Run on this computer** in the connection screen (or connect to another computer running easy-study).
2. Drop a lecture PDF into the library. Group lectures into courses; a lecture studied later gets the summaries of the earlier ones.
3. Open a lecture and ask. The tutor gets the whole deck once, then the slide you are on and its neighbors with every question.
4. Optional: **Make digest** writes a per-slide summary (`DIGEST.md`) that later sessions reuse; every Q&A is kept in `STUDY_NOTES.md`.

LLMs: sign in to `claude` (Claude Code) or `codex` once in a terminal, or set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.

## Recording lectures

Press the round microphone button at the top to record; transcription runs locally with whisper.cpp (the model is
downloaded on first use). Apple silicon uses Metal; Windows and Linux x64 use the graphics card through Vulkan when there
is one, and the CPU otherwise. Recordings can also be uploaded as audio or video files.

## Linux server (CLI)

For a headless Linux machine: the tarball holds Node, the server and the recording tools.

```bash
mkdir -p ~/.local/opt ~/.local/bin
tar -xzf easy-study-server-<version>-linux-<arch>.tar.gz -C ~/.local/opt
ln -sf ~/.local/opt/easy-study-server/bin/easy-study ~/.local/bin/easy-study
easy-study server          # prints the addresses and the access code (port 5350)
easy-study update          # downloads the latest version, verifies its signature, replaces the install
```

Connect from the desktop app (**Connect to another computer**) or a browser. Data lives in `~/.local/share/easy-study`.

## License

MIT. Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
