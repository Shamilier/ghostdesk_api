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
- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` – storage configuration.
- `S3_PRESIGN_EXPIRES_SEC` – presigned URL lifetime in seconds (default 600).
- `S3_FORCE_PATH_STYLE` – set to `true` if the storage provider requires path-style access.
- `RECORDINGS_MAX_BYTES` – maximum allowed recording size in bytes.
- `PUBLIC_APP_ORIGIN` – SPA origin allowed by CORS in addition to `http://localhost:3000`.

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
