# 🍌 nano-banana-cli

A tiny CLI for generating images with Google Gemini — straight from your terminal.

No API key needed. It drives a real browser behind the scenes, signs in with your Google account, and downloads the result.

```sh
nanban generate "a golden retriever wearing a tiny wizard hat"
```

---

## How it works

`nanban` uses Puppeteer to automate a Chrome/Chromium browser window that talks to [Gemini](https://gemini.google.com). It navigates to the Gemini image generation UI, types your prompt, waits for the result, and saves the downloaded PNG to disk.

Your Google session is saved in `~/.nban/profile/` so you only need to sign in once.

---

## Prerequisites

- [Bun](https://bun.sh) — used to run the TypeScript source directly
- A Google account with access to Gemini

Chrome is auto-detected if installed. If it's not found, Puppeteer's bundled Chromium is used instead.

---

## Installation

The quickest way is to run it directly without installing anything:

```sh
# with Bun
bunx nanban generate "a sunset over the ocean"

# with npm
npx nanban generate "a sunset over the ocean"
```

Or install it globally so `nanban` is always available:

```sh
npm install -g nanban
# or
bun add -g nanban
```

**From source:**

```sh
git clone https://github.com/hffmnnj/nano-banana-cli
cd nano-banana-cli
bun install
bun run src/index.ts generate "a sunset over the ocean"
```

---

## Setup: Sign in once

Before generating anything, you'll need to sign in to your Google account:

```sh
nanban auth
```

This opens a real browser window. Sign in normally, then close the window when you're done. Your session is saved and reused for future generations — you won't need to do this again unless the session expires.

---

## Generating images

### Single image

```sh
nanban generate "a rainy Tokyo street at night, neon reflections"
```

The image is saved as `nban-{timestamp}.png` in your current directory.

### Custom output path

```sh
nanban generate "a minimalist mountain landscape" --output ./art/mountain.png
```

### Multiple images at once

```sh
nanban generate "an astronaut tending a garden on mars" --count 4
```

Each image gets its own file: `mountain-1.png`, `mountain-2.png`, etc. They're generated in parallel across browser tabs, so it's as fast as Gemini allows.

---

## All options

```
nanban generate <prompt> [options]

Arguments:
  prompt              Your image generation prompt (required)

Options:
  -o, --output        Output file path (default: ./nban-{timestamp}.png)
  -n, --count         Number of images to generate (default: 1)
  -v, --verbose       Print detailed automation logs
      --headed        Run the browser visibly (useful for watching what's happening)
  -d, --debug         Write a debug log to ~/.nban/debug/ and keep the browser open on failure
```

---

## Debugging

If something isn't working, `--headed` lets you watch the browser in real time:

```sh
nanban generate "a stormy ocean" --headed
```

For deeper inspection, `--debug` writes a timestamped log to `~/.nban/debug/`:

```sh
nanban generate "a stormy ocean" --headed --debug
```

When `--debug` is active, the browser stays open on failure so you can see exactly where things went wrong.

---

## File locations

| Path | Purpose |
|------|---------|
| `~/.nban/profile/` | Saved browser session (your Google login) |
| `~/.nban/debug/` | Debug logs (only written with `--debug`) |
| `./nban-{timestamp}.png` | Default output location |

---

## Notes & limitations

- This tool automates the Gemini web interface. It's not using an official API, so it may break if Google changes the UI.
- Image generation can take 30–60+ seconds depending on Gemini's load.
- A 6-minute generation watchdog is in place — if Gemini takes longer than that, the request is abandoned and an error is returned.
- If your session expires, just run `nanban auth` again.
- `nanban` automatically switches you to the **Pro** model, this will be updated once Google releases a good fast model.

---

## License

MIT — see [LICENSE](./LICENSE).

Made by James Hoffmann.
