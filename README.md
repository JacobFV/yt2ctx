<div align="center">

<img src="assets/banner.svg" alt="yt2ctx — cinematic context compiler" width="860">

<br/>
<br/>

<img src="assets/landing.png" alt="The yt2ctx web app — &ldquo;The Reference Monograph&rdquo;" width="880">

<br/>
<br/>

**Turn any YouTube video into a VLM-ready context pack** — a timed transcript,
the frames that actually matter, and the cinematic grammar underneath, compiled
into copy-paste artifacts your coding agents can build from.

<br/>

![License](https://img.shields.io/badge/license-MIT-c5341b?style=flat-square)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-211c17?style=flat-square)
![Next.js](https://img.shields.io/badge/Next.js-16-211c17?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-211c17?style=flat-square)
![CI](https://img.shields.io/github/actions/workflow/status/JacobFV/yt2ctx/ci.yml?branch=main&style=flat-square&label=CI)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-c5341b?style=flat-square)

[Overview](#overview) · [Quick start](#quick-start) · [Web app](#web-app) ·
[CLI](#cli) · [MCP server](#mcp-server) · [HTTP API](#http-api) ·
[Contributing](#contributing) · [Roadmap](#roadmap)

</div>

---

## Overview

`yt2ctx` is a pipeline that watches a YouTube video the way a film editor
would, then writes down what it learned. It is not just a transcript tool — the
goal is to turn **reference cinema into executable production grammar** for
coding agents and downstream generation systems.

Given a URL, it:

1. downloads the video and extracts a compressed audio track
2. transcribes speech with per-segment timestamps
3. samples candidate frames across the timeline
4. describes and scores every frame with OpenAI vision + embeddings
5. selects the most representative frames (top-k or salience-density)
6. compiles a **style bible**, **Blender/Remotion-ready shot specs**, a
   **Codex/Claude implementation prompt**, and **anti-slop validators**
7. writes Markdown, JSON, the selected frame JPGs, and a ZIP bundle

It ships as **three interfaces over one pipeline** — a web app, a CLI, and an
MCP stdio server.

```
URL ─▶ download ─▶ audio ─▶ transcribe ─▶ sample frames ─▶ vision + embeddings
    ─▶ score & select ─▶ compile cinematic grammar ─▶ artifacts ( md · json · jpg · zip )
```

## Why use it?

- **Agent-ready outputs**: produces Markdown, JSON, selected frames, shot specs,
  and implementation prompts instead of a transcript alone.
- **One core pipeline**: the web app, CLI, HTTP API, and MCP server all share the
  same analysis logic.
- **Portable artifacts**: every run writes a self-contained job folder and ZIP
  bundle that can be shared with humans or passed to downstream tools.
- **OSS-friendly by default**: typed TypeScript, explicit environment config,
  issue templates, CI, Dependabot, and contribution guidance are included.

## How it works

| Stage | What happens |
|-------|--------------|
| **Download** | `yt-dlp` (bundled via `youtube-dl-exec`) fetches the best MP4. |
| **Audio** | Bundled `ffmpeg` demuxes a 16 kHz mono speech track. |
| **Transcribe** | OpenAI transcription returns verbose JSON with segment timestamps. |
| **Sample** | `ffmpeg` extracts candidate frames at a configurable interval. |
| **Vision** | Each frame is described, tagged, and scored for salience. |
| **Embed** | Frame descriptions are embedded to measure semantic novelty. |
| **Select** | A weighted score picks top-k or density-sampled frames. |
| **Compile** | A vision model extracts the reusable cinematic grammar. |
| **Package** | Everything is written to disk and zipped. |

## Requirements

- **Node.js 20+**
- An **`OPENAI_API_KEY`**
- A Postgres **`DATABASE_URL`** for the authenticated web app
- Network access to YouTube and OpenAI

`ffmpeg` and `ffprobe` are bundled — no system install required.

## Quick start

```bash
git clone https://github.com/JacobFV/yt2ctx.git
cd yt2ctx
npm install

cp .env.example .env
# open .env and set OPENAI_API_KEY and DATABASE_URL

npm run dev        # web app at http://localhost:3000
```

Or skip the browser and go straight to the CLI:

```bash
npm run cli -- "https://www.youtube.com/watch?v=VIDEO_ID"
```

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run lint
npm run build
```

The build runs the Next.js app and compiles the CLI/MCP binaries into `dist/`.
Generated analysis output is written to `.yt2ctx/` by default and should not be
committed.

## Project layout

| Path | Purpose |
|------|---------|
| `src/core/` | Shared download, transcription, frame analysis, scoring, rendering, and packaging logic. |
| `src/app/` | Next.js web app, docs pages, and HTTP API route. |
| `src/cli.ts` | Command-line interface over the core pipeline. |
| `src/mcp.ts` | MCP stdio server exposing `watch_youtube`. |
| `assets/` | README and product artwork. |
| `.github/` | Issue forms, PR template, CI, Dependabot, labels, and repo assets. |

---

## Web app

```bash
npm run dev
```

Open `http://localhost:3000`, create an account or sign in, paste a YouTube URL,
and run analysis. The interface is a single editorial experience — *"The
Reference Monograph"* — styled as a printed film publication: warm paper, ink,
one printer's red, and the two moments you *watch* (the processing frame and the
lightbox) drop to theater black.

- a **URL composer** that detects the video and shows its thumbnail before you run
- **account auth** with HttpOnly sessions and a Postgres-backed video library
- a collapsible **Tuning** panel for frame count, selection mode, and sampling
- **live pipeline progress** — every stage reports in real time with an overall
  percentage, an elapsed clock, and per-frame counts, instead of a blind spinner
- a **result view** with tabs for the watch pack, frames, style bible, shot
  specs, Codex prompt, and slop warnings
- rendered Markdown with a Reading/Raw toggle, per-tab copy, and `.md` download
- a **frame gallery** with a keyboard-navigable lightbox and per-frame downloads
- a one-click artifact **ZIP** download
- responsive across desktop and mobile, with reduced-motion support

## CLI

```bash
npm run cli -- "https://www.youtube.com/watch?v=VIDEO_ID" -k 8 --mode all
```

Useful options:

```bash
npm run cli -- "<url>" \
  --output .yt2ctx \
  --top-k 10 \
  --selection-mode density \
  --mode style \
  --candidate-interval 6 \
  --max-candidates 48 \
  --frame-width 768 \
  --quiet
```

| Option | Default | Description |
|--------|---------|-------------|
| `-k, --top-k <n>` | `8` | Number of frames to select. |
| `-m, --mode <mode>` | `all` | Output: `watch`, `style`, `shot-specs`, `prompt`, `all`. |
| `--selection-mode <mode>` | `density` | Frame selection: `density` or `top-k`. |
| `--candidate-interval <s>` | `8` | Seconds between sampled frames. |
| `--max-candidates <n>` | `36` | Candidate frames sent to vision analysis. |
| `--frame-width <px>` | `768` | Extracted frame width. |
| `-o, --output <dir>` | `.yt2ctx` | Output directory. |
| `--json` | — | Print JSON metadata instead of Markdown. |
| `--with-data-urls` | — | Include base64 data URLs in JSON output. |
| `--quiet` | — | Suppress the live progress display. |

The CLI renders a live progress bar on **stderr** as it moves through each
pipeline stage. **stdout** only ever receives the requested artifact text or
JSON, so it stays safe to pipe.

## MCP server

yt2ctx exposes the pipeline to MCP clients (Claude Desktop, Claude Code, and
any other agent that speaks MCP) as a single tool: **`watch_youtube`**.

### 1. Build the server

```bash
npm install        # if you have not already
npm run build:bin  # produces dist/mcp.js
```

This compiles a standalone stdio server to `dist/mcp.js`.

### 2. Register it with a client

The server needs `OPENAI_API_KEY` in its environment. It will read a `.env` file
in its working directory if one exists, but because MCP clients launch the
process from an arbitrary directory, **passing the key explicitly in the client
config is recommended**.

<details open>
<summary><b>Claude Desktop</b></summary>

<br/>

Edit the config file:

- macOS — `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows — `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "yt2ctx": {
      "command": "node",
      "args": ["/absolute/path/to/yt2ctx/dist/mcp.js"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Restart Claude Desktop. `watch_youtube` will appear in the tools list.

</details>

<details>
<summary><b>Claude Code</b></summary>

<br/>

```bash
claude mcp add yt2ctx \
  --env OPENAI_API_KEY=sk-... \
  -- node /absolute/path/to/yt2ctx/dist/mcp.js
```

Verify with `claude mcp list`.

</details>

<details>
<summary><b>Any other MCP client</b></summary>

<br/>

Launch this command as a **stdio** MCP server, with `OPENAI_API_KEY` in its
environment:

```bash
node /absolute/path/to/yt2ctx/dist/mcp.js
```

</details>

### 3. `watch_youtube` arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `url` | *(required)* | YouTube video URL. |
| `topK` | `8` | Number of frames to select. |
| `mode` | `density` | Frame selection: `density` or `top-k`. |
| `outputMode` | `all` | `watch`, `style`, `prompt`, `shot-specs`, or `all`. |
| `candidateIntervalSeconds` | `8` | Seconds between sampled frames. |
| `maxCandidateFrames` | `36` | Candidate frames sent to vision analysis. |
| `frameWidth` | `768` | Extracted frame width. |
| `outputDir` | *(optional)* | Where to write artifacts. |

The tool returns the requested text artifact plus the selected frames as MCP
image content, and also writes the full artifact set to disk.

## HTTP API

`GET /api/analyze` returns the endpoint contract as JSON, so the API is
self-documenting. `POST /api/analyze` requires an authenticated web session,
runs the pipeline, saves the completed analysis to the signed-in user's Postgres
video library, and **content-negotiates** its response so the same endpoint
serves the browser and headless agents:

- **`Accept: application/x-ndjson`** — streams newline-delimited JSON. Zero or
  more `{"type":"progress","stage":"vision","pct":0.71,...}` events, then one
  `{"type":"result","result":{...}}` line. Failures arrive as
  `{"type":"error","message":"..."}`. The web app uses this for live progress.
- **Any other `Accept`** — returns a single buffered JSON result object, or
  `{"error":"..."}` with HTTP 400. The simplest thing for an agent to
  `fetch().then(r => r.json())`.

**Request body** (JSON): `url` *(required)*, `topK`, `mode` (`density` |
`top-k`), `candidateIntervalSeconds`, `maxCandidateFrames`, `frameWidth`.

**Result**: `metadata`, `markdown`, `frames` (each with an inline `dataUrl`),
`cinematic` artifacts, and a base64 `zipDataUrl`.

```bash
# Discover the contract
curl -s http://localhost:3000/api/analyze

# Headless agent — one buffered JSON result
curl -s -X POST http://localhost:3000/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://youtu.be/VIDEO_ID"}'

# Live streaming progress
curl -N -X POST http://localhost:3000/api/analyze \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/x-ndjson' \
  -d '{"url":"https://youtu.be/VIDEO_ID"}'
```

---

## Artifacts

Every run writes a job folder under the output directory (`.yt2ctx/<job-id>/`):

| File | Contents |
|------|----------|
| `watch.md` | Timed transcript plus representative frame metadata. |
| `style-bible.md` | The extracted cinematic production grammar. |
| `shot-specs.md` / `shot-specs.json` | Blender/Remotion-ready shot specs. |
| `codex-prompt.md` | A direct implementation prompt for coding agents. |
| `metadata.json` | The full structured analysis result. |
| `frames/*.jpg` | The selected frame images. |
| `yt2ctx-artifacts.zip` | Everything above, bundled. |

## Cinematic grammar compiler

The extra outputs are designed for downstream generation systems.

**`style-bible.md`** extracts the production grammar: cinematic ontology,
reference lineage, camera/lens/lighting/material/edit/typography/sound language,
narration register and forbidden phrases, reusable shot patterns, and transfer
rules for new products.

**`shot-specs.json`** makes the reference executable: source frame and
timestamp, shot type and purpose, lens/focal length/aperture/rig/movement/focus
behavior, lighting setup, material emphasis, Blender render passes, diffusion
finishing intent, Remotion role, and anti-slop forbidden moves.

**`codex-prompt.md`** is a direct implementation prompt for coding agents. It
tells Codex/Claude to build a physically grounded Blender-first pipeline with
diffusion as finishing and Remotion as editorial assembly — not as the visual
substrate.

**`slopWarnings`** are validator-ready rules that catch presentation-deck
failure modes: arbitrary floating UI, LinkedIn announcement language, missing
lens metadata, and ungrounded abstract AI visuals.

## Frame selection

- **`top-k`** sorts candidate frames by score and returns the highest scoring.
- **`density`** treats salience as a timeline density and samples across
  weighted buckets — usually a more representative sequence across the whole
  video while still preferring information-rich moments.

The score combines OpenAI vision salience, semantic novelty from frame
descriptions, visual scene-change novelty, nearby transcript density, and
colorfulness.

## Configuration

Environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | *(required)* | Your OpenAI API key. |
| `DATABASE_URL` | *(required for web)* | Postgres connection string for accounts, sessions, and saved video analyses. |
| `OPENAI_TRANSCRIBE_MODEL` | `whisper-1` | Transcription model. |
| `OPENAI_VISION_MODEL` | `gpt-4.1-mini` | Vision + grammar model. |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model. |
| `YT2CTX_OUTPUT_DIR` | `.yt2ctx` | Default artifact directory. |

`whisper-1` is the default because it supports verbose JSON with segment
timestamps.

## Deployment

This repo is intended to deploy through a linked GitHub repository on Vercel.
Push to the configured production branch and let Vercel build automatically.

Set `OPENAI_API_KEY` in the Vercel project settings before relying on automatic
deployments. The web app also requires `DATABASE_URL`; the project is designed
to use a Vercel Marketplace Postgres provider such as Neon, which injects the
connection environment variables when connected to the project. The analyze
route is configured for the Node.js runtime with a 300 second function duration.
Serverless limits still apply — long videos are better processed through the CLI
or MCP server; short videos and clips fit the hosted web path.

> [!IMPORTANT]
> The hosted web app requires authentication, but each analysis still costs real
> OpenAI usage. Before widening access to a public deployment, add usage limits
> and billing controls — see [`TODO.md`](./TODO.md).

## Roadmap

Planned work — including gating the public web app behind authentication and
billing so it cannot run up unbounded OpenAI spend — is tracked in
[`TODO.md`](./TODO.md).

## Contributing

Issues and pull requests are welcome. Good contributions include bug fixes,
documentation improvements, sharper prompts/artifact schemas, better frame
selection heuristics, and MCP/client compatibility work.

Before opening a PR:

1. Search existing issues to avoid duplicate work.
2. Keep the change focused and include screenshots or sample artifacts for UI
   and output changes.
3. Run `npm run typecheck`, `npm run lint`, and, when practical,
   `npm run build`.
4. Do not commit `.env`, API keys, private video URLs, or generated `.yt2ctx/`
   output.

Use the issue templates for bugs and feature requests, and the PR template for
review context. Security reports should be opened privately through GitHub
Security Advisories rather than public issues.

## Community health

This repository includes:

- bug and feature request issue forms
- a pull request template
- CI for typecheck, lint, and build
- Dependabot configuration for npm and GitHub Actions
- a label set for triage
- a funding placeholder for future sponsorship setup

## Notes

Only process videos you have the right to download and analyze. YouTube
availability and extractor behavior can change; `youtube-dl-exec` bundles
`yt-dlp`, which is more robust than browser-only download libraries.

## License

[MIT](./LICENSE)
