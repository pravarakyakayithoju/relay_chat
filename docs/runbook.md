# Runbook

How to run, inspect and fix the system.

## Requirements

- Docker Desktop (with at least 4 GB of memory given to Docker)
- Node.js 22 or newer (`node -v`)

## Start and stop

| Goal | Command |
|---|---|
| Everything in Docker | `docker compose up --build -d` → http://localhost:8080 |
| Develop with reload | `npm install`, `npm run deps:up`, `npm run migrate`, `npm run dev` → http://localhost:5173 |
| Add dashboards | `docker compose --profile monitoring up -d` → Grafana http://localhost:3001 |
| Stop | `docker compose down` |
| Stop and delete all data | `docker compose down -v` |
| Rebuild after code changes | `docker compose up --build -d` |

After the first `npm install`, commit the generated `package-lock.json` so
everyone (and CI) installs identical versions.

## Ports

| Port | What |
|---|---|
| 8080 | Nginx: the app (Docker mode) |
| 5173 | Vite dev server (development mode) |
| 3000 / 4000 / 9100 | API / gateway / workers metrics (development mode) |
| 5432 / 6379 / 19092 | Postgres / Redis / Kafka, exposed for tools on your machine |
| 9090 / 3001 | Prometheus / Grafana |

## Is it working?

```bash
docker compose ps                    # everything "running"; migrate "exited (0)"
npm run smoke                        # 17 end-to-end checks
curl -s localhost:8080/api/me        # {"error":{"code":"unauthorized",...}} means the API is reachable
```

## Looking inside

```bash
docker compose logs -f api gateway workers          # live logs
docker compose exec postgres psql -U chat chat      # SQL shell
docker compose exec redis redis-cli                 # Redis shell
```

| Question | Command |
|---|---|
| Which real-time topics are subscribed? | `redis-cli pubsub channels` |
| Who is online? | `redis-cli --scan --pattern 'presence:*'` |
| Is the outbox behind? | `SELECT count(*) FROM outbox WHERE published_at IS NULL;` |
| How far behind is a worker? | `docker compose exec redpanda rpk group describe relay-notifications` |
| What failed permanently? | `docker compose exec redpanda rpk topic consume chat.message-events.dlq` |
| How are messages spread over partitions? | `SELECT tableoid::regclass, count(*) FROM messages GROUP BY 1;` |
| Which migrations ran? | `SELECT * FROM schema_migrations;` |

## Troubleshooting

**`port is already allocated` on 5432 or 6379.** You have Postgres or Redis
installed locally. Stop it, or change the left-hand number in `ports:` in
`docker-compose.yml` (for example `"5433:5432"`) and set `DATABASE_URL` to
match when running in development mode.

**The page loads but nothing happens after login / requests return 502.**
The API containers are not up. `docker compose ps`, then
`docker compose logs api migrate`. If `migrate` failed, the API never starts.

**Scaled a service and Nginx does not use the new instances.** Nginx resolves
service names once at start. Run `docker compose restart nginx`.

**Messages send but do not appear live.** Check the sidebar status (it should
say "Live"). Then `docker compose logs gateway`, and
`redis-cli pubsub channels` should list `channel:...` entries while someone is
connected.

**Mentions and search do not work, but chat does.** That is the asynchronous
pipeline: `docker compose logs workers redpanda`. A growing outbox count means
the relay cannot reach Kafka.

**`npm run dev`: workers cannot connect to Kafka.** From your machine the
broker is `localhost:19092` (the default). Inside Docker it is
`redpanda:9092`. They are different listeners on purpose.

**Redpanda keeps restarting.** Usually too little memory for Docker. Raise it
in Docker Desktop's settings.

**Signup returns 429 during a load test.** Expected: 20 signups per minute per
IP. Start with `AUTH_RATE_LIMIT=1000000` as described in
`loadtests/README.md`.

**I want a clean slate.** `docker compose down -v && docker compose up --build -d`.

## Adding a database migration

1. Create `apps/api/src/db/migrations/005_<what_it_does>.sql`.
2. Write plain SQL. The whole file runs in one transaction.
3. `npm run migrate`.

Never edit a migration that has already been applied anywhere; add a new one.

## Adding a new background job

1. Write `apps/workers/src/handlers/<name>.ts` exporting
   `async (event: MessageCreatedEvent) => void`. Make it idempotent.
2. Register it in `apps/workers/src/index.ts` with `runWorker`.
3. Add its name to `WorkerName` in `apps/workers/src/config.ts`.

It gets its own consumer group and will first receive every past event, which
is why the handler has to tolerate being run for old messages.
