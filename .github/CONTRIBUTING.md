# Contributing

Thanks for helping improve yt2ctx.

## Development

```bash
npm install
cp .env.example .env
npm run dev
```

Set `OPENAI_API_KEY` in `.env` before running the pipeline locally.

## Checks

Run the relevant checks before opening a pull request:

```bash
npm run typecheck
npm run lint
npm run build
```

## Pull requests

- Keep changes focused.
- Include screenshots or sample artifacts for UI and output changes.
- Update docs when behavior, options, routes, or artifact shapes change.
- Do not commit `.env`, API keys, private video URLs, or generated `.yt2ctx/` output.

## Issues

Use the bug report and feature request templates when possible. Include the
interface you used: web app, CLI, MCP server, HTTP API, or core library.
