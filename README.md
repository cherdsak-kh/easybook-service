# easybook-service (backend)

EasyBook backend — a standalone **NestJS** API. Serves the versioned REST contract
under `/api/v1` and publishes an **OpenAPI spec** (the source of truth the frontend
generates its types from).

- **Frontend repo:** `easybook-app` (React/Vite/LIFF)
- **Runs on port 3300**

## Stack
NestJS 11 · TypeScript · Prisma 7 + PostgreSQL (pg driver adapter) · Swagger
(`@nestjs/swagger`) · LINE Messaging API (`@line/bot-sdk`).

## Prerequisites
- Node 20 LTS (`.nvmrc`) · npm
- A PostgreSQL database
- (For LINE features) a Messaging API channel

## Setup
```bash
npm install
cp .env.example .env        # then fill DATABASE_URL, LINE_* etc.
npm run prisma:generate
npm run prisma:migrate      # apply migrations
npm run start:dev           # http://localhost:3300
```

## Key URLs
| URL | Purpose |
|-----|---------|
| `http://localhost:3300/api/v1/health` | Health (+ DB status) |
| `http://localhost:3300/docs` | Swagger UI |
| `http://localhost:3300/docs-json` | OpenAPI spec (frontend codegen source) |

## Scripts
`build` · `start` / `start:dev` · `test` / `test:e2e` · `prisma:generate` /
`prisma:migrate` / `prisma:studio` · `line:setup-richmenu`.

## Environment
`PORT` (3300) · `CORS_ORIGIN` (http://localhost:2200) · `SWAGGER_ENABLED` ·
`DATABASE_URL` · `LINE_CHANNEL_ACCESS_TOKEN` · `LINE_CHANNEL_SECRET`. See `.env.example`.
