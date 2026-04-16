# jarvis

Personal Gmail triage assistant with a FastAPI backend and a Next.js dashboard.

## Docker deployment

This repo is now packaged to run as two containers:

- `api`: FastAPI + Gmail/OpenAI logic on port `8000`
- `web`: Next.js dashboard on port `3000`

The dashboard now talks to the backend through same-origin `/api` requests. In Docker, the Next.js app rewrites `/api/*` to the internal `api` service automatically.

### Files

- [docker-compose.yml](/Users/jt_gladden/Dev/jarvis/docker-compose.yml)
- [Dockerfile.backend](/Users/jt_gladden/Dev/jarvis/Dockerfile.backend)
- [jarvis-ui/Dockerfile](/Users/jt_gladden/Dev/jarvis/jarvis-ui/Dockerfile)
- [.env.example](/Users/jt_gladden/Dev/jarvis/.env.example)

### For Dockge

1. Create a stack from this repo or paste in `docker-compose.yml`.
2. Copy `.env.example` to `.env` and fill in `OPENAI_API_KEY`.
3. Create a local `data/` folder beside the compose file.
4. Put your Gmail OAuth client file at `data/credentials.json`.
5. Start the stack.

The backend stores its persistent local state in the mounted `data/` folder, including:

- `data/token.json`
- `data/journal_entries.db`
- `data/tasks.db`
- `data/classification_cache.db`
- `data/classification_guidance.json`

That means Gmail auth, journal entries, task edits/completions, saved classification cache, and guidance survive container restarts as long as the `data/` folder is preserved.

### Important Gmail note

The first Gmail OAuth authorization still needs a valid token flow. The easiest path is usually:

1. Run the backend locally once and complete Google login.
2. Copy the generated `token.json` into `data/token.json`.
3. Deploy with Docker after that.

If you want fully headless server auth later, you would need to move away from the local browser OAuth flow currently used in `app/gmail_client.py`.
