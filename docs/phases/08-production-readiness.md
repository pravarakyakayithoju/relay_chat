# Phase 8: Production readiness

**Problem:** the system works when you are watching it. Production means it has
to survive abuse, tell you what it is doing, restart without dropping users,
and be changed safely.

## What was built

| Concern | Where |
|---|---|
| Rate limiting | `apps/api/src/middleware/rateLimit.ts` |
| Metrics | `/metrics` on every service; `infra/monitoring/` |
| Structured logs | `pino`, JSON lines |
| Health checks | `/healthz` and `/readyz` |
| Graceful shutdown | `server.ts` in each service |
| Containers | `infra/docker/`, `docker-compose.yml` |
| CI | `.github/workflows/ci.yml` |
| Kubernetes | `infra/k8s/` |
| Load tests | `loadtests/` |
| End-to-end test | `scripts/smoke.ts` |

## Rate limiting

Counters live in Redis because there are several API instances; a per-process
counter would allow `limit x instances`. Increment and expiry run in one Lua
script so they are atomic.

- Signup and login: 20 per minute **per IP** (there is no user yet).
- Sending: 30 per 10 seconds **per user** (many people share an office IP).

This is a fixed-window counter, the simplest algorithm. Its weakness: a client
can send a full quota at the end of one window and another at the start of the
next. A sliding window or token bucket smooths that at the cost of more state.

If Redis is unreachable the limiter lets requests through ("fail open"). For a
chat app, serving unthrottled beats being down. For a login endpoint under
attack you might choose the opposite.

## Observability

**Metrics** answer "is it healthy, and what is the trend?". The ones exported
map onto the standard questions:

| Question | Metric |
|---|---|
| How much traffic? | `http_request_duration_seconds_count` |
| How slow? | `http_request_duration_seconds` (histogram → p50/p95/p99) |
| How many errors? | the same metric filtered by `status=~"5.."` |
| How full? | `ws_connections`, `outbox_pending` |

Why percentiles and not averages: if 99 requests take 10 ms and one takes 5 s,
the average is 60 ms and hides the user who waited five seconds. p99 shows it.

Labels use the route template (`/api/channels/:channelId/messages`), never the
real URL. One label value per channel id would create an unbounded number of
time series and take down the metrics system (a "cardinality explosion").

`outbox_pending` is the best single alarm in the system: if it climbs, the
asynchronous pipeline is behind, whatever the cause.

**Logs** answer "what exactly happened to this request?". They are JSON so
they can be filtered by field.

Not built: distributed tracing (following one request across API → Kafka →
worker with a shared trace id, e.g. OpenTelemetry). It is the natural next
addition.

## Liveness and readiness

Two different questions that orchestrators ask separately:

- `/healthz`, **liveness**: is the process stuck? Failing means "restart me".
  It must not check dependencies, or a database outage would make the
  orchestrator restart every healthy API pod in a loop.
- `/readyz`, **readiness**: can I serve traffic right now? Failing means "take
  me out of the load balancer for now". This one checks Postgres and Redis.

## Graceful shutdown

Every deploy stops old processes. On `SIGTERM`:

- **API:** stop accepting connections, finish in-flight requests, close pools.
- **Gateway:** close each socket with code 1001 so clients reconnect elsewhere
  at once, clear presence, then exit.
- **Workers:** stop the relay loop, let the current event finish, leave the
  consumer groups (so Kafka reassigns partitions immediately).

Without this, every deploy would drop requests mid-flight and leave users
shown as online.

## Containers and CI

One backend image serves all three services, selected by an `APP` variable.
The Dockerfile copies `package.json` files before the source so dependency
installation is cached across code changes, and the process runs as a non-root
user.

The CI pipeline has three jobs: type-check, unit tests and web build;
migrations against a real Postgres; and an end-to-end job that starts the whole
stack with Docker Compose and runs the smoke test.

Simplification to know about: the containers run TypeScript directly through
`tsx` instead of compiling to JavaScript first. That removes a build step and
keeps one code path for development and production, at the cost of slower
start-up and a development tool in the production image. A stricter setup
compiles in one Docker stage and copies only the output into the final image.

## See it yourself

```bash
docker compose --profile monitoring up -d
# Grafana   http://localhost:3001  ->  Relay overview
# Prometheus http://localhost:9090
k6 run loadtests/http.js          # and watch the dashboard move
```

Trip the rate limiter:

```bash
for i in $(seq 1 25); do
  curl -s -o /dev/null -w '%{http_code} ' localhost:8080/api/auth/login \
    -H 'content-type: application/json' -d '{"email":"x@example.com","password":"wrong"}'
done   # 401s, then 429s
```

Watch a graceful shutdown: with a browser connected, run
`docker compose restart gateway` and watch the status go to "Reconnecting…"
and back.

## What a real production system would still need

TLS; secrets from a secrets manager; database backups and tested restores;
Postgres and Redis replication with failover; connection pooling (PgBouncer);
alerting rules; tracing; token revocation and refresh tokens; audit logs;
dependency and image scanning.

## Questions to be ready for

- Where do you keep rate-limit counters when you have ten servers, and why?
- Fixed window, sliding window, token bucket: differences?
- Why p99 instead of the average?
- Liveness versus readiness: what goes wrong if you use the same check for both?
- What should a server do when it receives SIGTERM?
- What would you alert on in this system?
- What is a cardinality explosion in metrics?
