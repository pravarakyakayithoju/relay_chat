# Phase 1: The monolith

**Goal:** a correct, working chat product on one server and one database.
Nothing here is about scale. It is about getting the foundations right so that
later phases have something solid to change.

## What was built

- Schema: users, workspaces, channels, memberships, messages
  (`apps/api/src/db/migrations/001_init.sql`)
- REST API organised by feature: `apps/api/src/modules/<feature>/routes.ts`
  (HTTP) and `service.ts` (logic and SQL)
- Signup and login with hashed passwords and JWTs
- Message history with cursor pagination
- A migration runner (`apps/api/src/db/migrate.ts`)

## Decisions that matter later

### Stateless auth with JWTs

A token contains the user id and is signed with a secret. Verifying it needs
no database or session store, so *any* API instance can handle *any* request.
That property is what makes phase 3 possible.

Trade-off: a token cannot be cancelled before it expires. Production systems
pair short-lived access tokens with refresh tokens, or keep a small revocation
list. Here a token lives 7 days.

### Passwords

Stored as bcrypt hashes, never as text. bcrypt is deliberately slow, so an
attacker who steals the table needs real time per guess. Login compares against
a dummy hash when the email does not exist, so the response time does not
reveal which emails are registered.

### Cursor pagination, not OFFSET

```sql
-- OFFSET: reads and throws away 100,000 rows to return 50
SELECT ... ORDER BY id DESC LIMIT 50 OFFSET 100000;

-- Cursor: jumps straight to the right place in the index
SELECT ... WHERE channel_id = $1 AND id < $2 ORDER BY id DESC LIMIT 50;
```

OFFSET gets slower the deeper you go. It is also wrong for a live feed: if
three messages arrive between loading page 1 and page 2, page 2 repeats three
messages. A cursor ("older than the last one I have") has neither problem.

### Let the database enforce rules

Uniqueness (usernames, channel names per workspace) is a database constraint.
The code inserts and handles the "duplicate" error. Checking first with a
`SELECT` looks equivalent but has a race: two requests can both see "free" and
both insert.

### Validate at the edge

Every request body is parsed with a zod schema before any logic runs. Bad
input becomes a 400 with a readable message, not a 500 from deep in the code
or a confusing database error.

### Layering

`routes.ts` knows about HTTP and nothing about SQL. `service.ts` knows about
SQL and nothing about HTTP. That is why phase 5 could add caching inside a
service function without touching a route.

## See it yourself

```bash
npm run deps:up && npm run migrate && npm run dev -w apps/api

curl -s localhost:3000/api/auth/signup -H 'content-type: application/json' \
  -d '{"username":"alice","email":"a@example.com","password":"password123"}'
```

Look at the query plan for history (`docker compose exec postgres psql -U chat chat`):

```sql
EXPLAIN SELECT id FROM messages
WHERE channel_id = '<a channel id>' AND id < 9000000000000000000
ORDER BY id DESC LIMIT 50;
```

You should see an index scan, not a sequential scan plus a sort.

## Where it breaks

- A new message only appears when someone refreshes. → Phase 2
- One process. If it dies, the product is down; when it is busy, everyone waits. → Phase 3

## Questions to be ready for

- Why is `OFFSET` pagination a problem on a large, frequently changing table?
- What is inside a JWT? What can and cannot the server trust about it?
- Why hash passwords with bcrypt rather than SHA-256?
- Why a composite index on `(channel_id, id)` instead of two separate indexes?
- How would you revoke a stolen token?
