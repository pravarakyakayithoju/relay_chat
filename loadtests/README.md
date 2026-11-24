# Load tests

These scripts use [k6](https://k6.io), a free load-testing tool. Install it
from the k6 website, or run it through Docker without installing anything:

```bash
docker run --rm -i --network host -v "$PWD/loadtests:/loadtests" grafana/k6 run /loadtests/http.js
```

(`--network host` works on Linux. On Windows and macOS use
`-e BASE_URL=http://host.docker.internal:8080` instead.)

## Before you run them

The API limits signups to 20 per minute per IP address, and a load test
creates hundreds of users from one machine. Start the stack with the limits
raised:

```bash
AUTH_RATE_LIMIT=1000000 SEND_RATE_LIMIT=1000000 docker compose up --build -d
```

On Windows PowerShell:

```powershell
$env:AUTH_RATE_LIMIT=1000000; $env:SEND_RATE_LIMIT=1000000; docker compose up --build -d
```

To watch the system while the test runs, also start the dashboards:

```bash
docker compose --profile monitoring up -d
# Grafana: http://localhost:3001  ->  Dashboards  ->  Relay overview
```

## The two scripts

| Script | Simulates | Main numbers |
|---|---|---|
| `http.js` | Users loading channel history and sending messages | `http_req_duration{name:send}`, `http_req_duration{name:history}`, `http_req_failed` |
| `ws.js` | Users holding a live WebSocket in one busy channel | `ws_delivery_latency`, `ws_messages_received` |

```bash
k6 run loadtests/http.js                       # 50 users
k6 run -e VUS=300 loadtests/http.js            # 300 users
k6 run -e VUS=1000 -e HOLD_SECONDS=60 loadtests/ws.js
```

## How to turn a run into something you can talk about

One number on its own means little. What is interesting is a **before/after
pair with a reason**. A good experiment changes exactly one thing:

1. Run the test and write down p50 / p95 / p99 and requests per second.
2. Change one thing (see the list below).
3. Run the same test again and compare.
4. Write down what changed and why, in `docs/benchmarks.md`.

Experiments worth doing, each tied to a phase:

| Change one thing | How | What you should expect to learn |
|---|---|---|
| 1 API instance vs 3 | `docker compose up -d --scale api=1`, then `--scale api=3`, then `docker compose restart nginx` | Whether the API or the database is the bottleneck |
| History cache off vs on | Start the stack with `RECENT_CACHE_TTL_SECONDS=0`, then again without it | How much load the cache takes off Postgres; watch the cache hit ratio panel |
| 1 gateway vs 3 | `--scale gateway=1` vs `--scale gateway=3` | How many connections one Node process holds, and whether delivery latency changes |
| 200 vs 2000 listeners in one channel | `-e VUS=...` on `ws.js` | Fan-out cost: one message becomes N socket writes |
| Workers stopped | `docker compose stop workers` during `http.js` | Sends stay fast while the outbox backlog grows, then drains when you start workers again |

Your laptop is running the load generator, the databases, and the app at the
same time, so absolute numbers will be lower than on real servers. That is
fine: the comparisons are what matter, and they are honest numbers you
measured yourself.
