# API reference

Base URL: `http://localhost:8080/api` (through Nginx) or
`http://localhost:3000/api` (API directly, in development).

## Conventions

- JSON in, JSON out.
- Every endpoint except signup and login needs `Authorization: Bearer <token>`.
- IDs are strings. Message ids are 64-bit integers written as strings, because
  JavaScript numbers cannot hold them exactly.
- Errors always look like this:

```json
{ "error": { "code": "validation_error", "message": "content: message is empty" } }
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `validation_error`, `bad_request` | The request is malformed |
| 401 | `unauthorized` | Missing, invalid or expired token; wrong password |
| 403 | `forbidden` | You are signed in but not allowed (not a member) |
| 404 | `not_found` | No such route or resource |
| 409 | `conflict` | Username, email or channel name already taken |
| 413 | `too_large` | Body over 64 KB |
| 429 | `rate_limited` | Slow down; see the `Retry-After` header |
| 500 | `internal` | A bug. Details are in the server log, not the response |

Every response carries `X-Instance` (which API instance answered). Rate-limited
routes also return `X-RateLimit-Limit` and `X-RateLimit-Remaining`.

## Auth

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/auth/signup` | `{ username, email, password }` | `201 { token, user }` |
| POST | `/auth/login` | `{ email, password }` | `200 { token, user }` |
| GET | `/me` | | `200 { id, username }` |

Usernames: 3 to 32 of `a-z 0-9 _`. Passwords: 8 to 72 characters. Both
endpoints are limited to 20 requests per minute per IP address.

## Workspaces

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/workspaces` | | `{ workspaces: Workspace[] }` |
| POST | `/workspaces` | `{ name }` | `201 Workspace` (also creates `#general`) |
| POST | `/workspaces/join` | `{ inviteCode }` | `200 Workspace` (also joins `#general`) |
| GET | `/workspaces/:id/members` | | `{ members: Member[] }` with `online` flags |

## Channels

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/workspaces/:id/channels` | | `{ channels: Channel[] }` with `isMember` and `unread` |
| POST | `/workspaces/:id/channels` | `{ name, isPrivate? }` | `201 Channel` |
| POST | `/channels/:id/join` | | `204` (public channels only) |
| POST | `/channels/:id/leave` | | `204` |
| POST | `/channels/:id/members` | `{ username }` | `204` (a member adds someone; the way into a private channel) |

## Messages

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/channels/:id/messages` | `?before=<messageId>&limit=<1-100>` | `{ messages, nextCursor }`, newest first |
| POST | `/channels/:id/messages` | `{ content, clientMessageId? }` | `201 Message`, or `200 Message` if it was a retry |
| POST | `/channels/:id/read` | `{ messageId }` | `204` |

**Pagination.** Request without `before` for the newest page. To go further
back, pass the returned `nextCursor` as `before`. `nextCursor` is `null` when
there is nothing older.

**Idempotency.** Send a fresh UUID as `clientMessageId` with each new message
and reuse it when retrying. The server stores one message per
`(channel, user, clientMessageId)` and returns the existing one on a repeat.

Sending is limited to 30 messages per 10 seconds per user. Content is 1 to
4000 characters.

## Search and notifications

| Method | Path | Query | Returns |
|---|---|---|---|
| GET | `/search` | `?workspaceId=<id>&q=<text>` | `{ hits: SearchHit[] }`, up to 20, newest first |
| GET | `/notifications` | | `{ notifications, unread }`, latest 30 |
| POST | `/notifications/read` | | `204`, marks all as read |

Search understands quoted phrases, `or`, and `-word` to exclude. Results only
include channels you can see. A message is searchable shortly after it is sent,
not instantly.

## Operations endpoints (not under `/api`)

| Path | Service | Purpose |
|---|---|---|
| `/healthz` | all | Liveness: the process is up |
| `/readyz` | API | Readiness: Postgres and Redis are reachable |
| `/metrics` | all | Prometheus metrics |

## WebSocket

Connect to `ws://localhost:8080/ws`. All frames are JSON text.

The first frame must authenticate, within 5 seconds:

```json
{ "type": "auth", "token": "<jwt>" }
```

The server answers `{ "type": "ready", "userId": "..." }`. From then on you
receive every event for the channels and workspaces you belong to; there is no
separate subscribe step.

### Client to server

| Event | Meaning |
|---|---|
| `{ type: "auth", token }` | Authenticate (first frame only) |
| `{ type: "ping" }` | Keep-alive; answered with `pong` |
| `{ type: "typing", channelId }` | "I am typing here". Throttled to one per 1.5 s |

Messages are **not** sent over the socket. They go through `POST
/channels/:id/messages`, so sending gets validation, rate limiting, idempotency
and a clear success or failure response.

### Server to client

| Event | When |
|---|---|
| `ready` | Authentication succeeded |
| `pong` | Reply to `ping` |
| `message.new` `{ message }` | A message was posted in one of your channels |
| `message.preview` `{ channelId, messageId, preview }` | A link preview became available |
| `typing` `{ channelId, userId, username }` | Someone else is typing |
| `presence.update` `{ userId, status }` | Someone in a shared workspace went online or offline |
| `notification.new` `{ notification }` | You were mentioned |
| `membership.changed` | Your workspaces or channels changed; refetch the lists |
| `channels.changed` `{ workspaceId }` | A public channel was created |
| `members.changed` `{ workspaceId }` | Someone joined the workspace |
| `error` `{ message }` | You sent something the server did not understand |

### Close codes

| Code | Meaning | Client should |
|---|---|---|
| 4401 | Authentication failed or timed out | Not retry with the same token |
| 1001 | Server is shutting down | Reconnect; another instance will answer |
| anything else | Network trouble | Reconnect with backoff, then refetch what is on screen |

The exact TypeScript definitions of every shape are in
`packages/shared/src/types.ts` and `packages/shared/src/events.ts`.
