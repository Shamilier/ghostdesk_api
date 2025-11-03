# Ghost AI API

This service exposes conversational endpoints for the Ghost AI assistants and manages audio recording uploads via presigned S3 URLs.

## Requirements

- Node.js 18+
- PostgreSQL compatible database
- S3-compatible object storage (tested with iDrive E2)

## Environment variables

Copy `.env.example` and adjust the values:

- `DATABASE_URL` – PostgreSQL connection string.
- `OPENAI_API_KEY` – API key used by the assistant endpoints.
- `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL`, `DEEPGRAM_LANGUAGE`, `TRANSCRIBE_MAX_CONCURRENCY` – configuration for the asynchronous
  transcription worker. If the API key is omitted, transcriptions are skipped.
- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` – storage configuration.
- `S3_PRESIGN_EXPIRES_SEC` – presigned URL lifetime in seconds (default 600).
- `S3_FORCE_PATH_STYLE` – set to `true` if the storage provider requires path-style access.
- `RECORDINGS_MAX_BYTES` – maximum allowed recording size in bytes.
- `PUBLIC_APP_ORIGIN` – SPA origin allowed by CORS in addition to `http://localhost:3000`.
- `AUTH_PROFILE_URL` – absolute URL of the Web portal endpoint (`GET /oauth/profile`). Requests are proxied with the same Bearer token.
- `AUTH_TIMEOUT_MS` – timeout for profile lookups (default `3000`).
- `AUTH_CACHE_TTL_MS` – LRU cache TTL for successful profiles in milliseconds (default `300000`).

## Authentication pipeline

Protected routes (currently `/v1/recordings/*`) no longer trust `X-User-Id` or opaque Bearer strings. Each call:

1. Extracts `Authorization: Bearer <access_token>` from the request.
2. Hashes the access token with SHA-256 and checks a 5-minute in-memory cache.
3. On cache miss, performs `GET ${AUTH_PROFILE_URL}` with the same Bearer token, waiting at most `AUTH_TIMEOUT_MS`.
4. Expects JSON `{ id: string, email?: string, plan?: string, created_at?: string }` and stores it in the cache.
5. Attaches `{ id, email, plan }` to `req.user` and processes the handler.

If the Web auth backend returns `401/403`, the API replies with `401`. Network errors or `5xx` responses surface as `503 { "error": "auth backend unavailable" }`. Rate limiting (120 req/min per IP) protects `/v1/recordings/*`. All S3 keys are derived from sanitized user IDs: `user_<safeId>/rec_<recordingId>/audio.m4a` where non `[A-Za-z0-9._-]` characters are replaced with `_`.

## Database migrations

```bash
npm run migrate
```

## Development

```bash
npm run dev
```

## Testing

```bash
npm test
```

## Audio recordings workflow

1. `POST /v1/recordings/init` – creates a DB record in `uploading` state and returns a presigned `PUT` URL.
2. Client uploads the `audio.m4a` file directly to object storage.
3. `POST /v1/recordings/complete` – validates upload via `HEAD`, enforces size limits and marks the record as `uploaded`.
4. `GET /v1/recordings` / `GET /v1/recordings/{id}` – list or fetch metadata, optionally returning a short-lived presigned `GET` URL.

The backend never proxies media bytes. Objects must stay private in the bucket, and playback uses short-lived presigned links. Configure CORS on the storage bucket to allow `GET` from `https://app.ghostai.ru` (and the dev origin) if playback from browsers is required.
