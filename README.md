# jarvis

Personal Gmail triage assistant with a FastAPI backend and a Next.js dashboard.

## iOS companion app

There is now a starter Apple Health companion app scaffold in [ios/README.md](/Users/jt_gladden/Dev/jarvis/ios/README.md).

This is a SwiftUI + HealthKit starting point for requesting Apple Health permissions on-device before sending approved health summaries to the backend.

The backend also supports daily health sync records through `POST /api/health/daily` and includes health summary data in the dashboard response.

## Docker deployment

This repo is now packaged to run as two containers:

- `api`: FastAPI + Gmail/OpenAI logic on port `8000`
- `web`: Next.js dashboard on port `3000`

The dashboard now talks to the backend through same-origin `/api` requests. In Docker, the Next.js app rewrites `/api/*` to the internal `api` service automatically.

### Files

- [docker-compose.yml](/Users/jt_gladden/Dev/jarvis/docker-compose.yml)
- [Dockerfile](/Users/jt_gladden/Dev/jarvis/Dockerfile)
- [jarvis-ui/Dockerfile](/Users/jt_gladden/Dev/jarvis/jarvis-ui/Dockerfile)
- [.env.example](/Users/jt_gladden/Dev/jarvis/.env.example)

### For Dockge

1. Create a stack from this repo or paste in `docker-compose.yml`.
2. Copy `.env.example` to `.env` and fill in `OPENAI_API_KEY`, `API_IMAGE`, and `WEB_IMAGE`.
3. Create a local `data/` folder beside the compose file.
4. Put your Gmail OAuth client file at `data/credentials.json`.
5. Start the stack.

Example image values:

- `API_IMAGE=ghcr.io/<your-user-or-org>/<repo>-api:latest`
- `WEB_IMAGE=ghcr.io/<your-user-or-org>/<repo>-web:latest`

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
