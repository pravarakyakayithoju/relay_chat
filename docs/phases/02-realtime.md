# Phase 2: Real-time delivery

**Problem:** HTTP is request and response. The server cannot tell a browser
"a new message arrived"; the browser would have to keep asking (polling), which
is slow to update and wasteful when nothing has changed.

**Solution:** a WebSocket: one long-lived connection per client that either
side can write to at any time. The code is in `apps/gateway`.

## What was built

- A WebSocket server (`apps/gateway/src/server.ts`) using the `ws` library
- Authentication as the first frame on the socket
- A routing table from topics to connections (`hub.ts`)
- Typing indicators and online presence
- Heartbeats to detect dead connections
- A client that reconnects on its own (`apps/web/src/socket.ts`)

## Decisions

### Send over HTTP, receive over the socket

Messages are sent with `POST`, not through the WebSocket. HTTP gives a clear
success or failure per message, status codes, rate limiting and idempotent
retries for free. The socket carries server-to-client events and tiny client
signals (typing, ping). Slack and Discord work the same way.

### Authenticate in the first frame, not the URL

Browsers cannot set headers on a WebSocket. The common shortcut is
`/ws?token=...`, but URLs are written to access logs by proxies and servers. So
the client connects, then sends `{type:"auth", token}`; a socket that has not
authenticated within 5 seconds is closed.

### Heartbeats

A TCP connection can die silently: a laptop lid closes, a phone leaves Wi-Fi.
Neither side is told. Every 30 seconds the gateway pings each socket; any
socket that did not answer the previous ping is terminated. Without this the
server slowly fills with ghost connections and presence shows people online
forever.

### Backpressure

`ws.send()` never blocks. If a client reads slower than the server writes,
the unsent data piles up in the server's memory. One stalled client in a busy
channel could grow without limit. The gateway checks `bufferedAmount` before
each write and disconnects a client that is more than 1 MB behind; the client
reconnects and reloads.

### Reconnection is the client's job, and it must be polite

When a gateway restarts, every client it held disconnects at the same instant.
If they all reconnect immediately they hit the replacement together (a
"thundering herd"). The client waits `min(15 s, 0.5 s x 2^attempt)` multiplied
by a random factor, so reconnections spread out.

### The socket is a hint; history is the truth

Events sent while a client was offline are simply missed. So after every
reconnection the client refetches the latest page over REST and merges it by
message id. Every source of messages (first load, older pages, live events,
the response to your own send) goes through one `mergeMessages` function,
which is why duplicates and out-of-order arrival do not matter.

## See it yourself

Open two browsers as two users in the same channel. Type in one: the other
shows "is typing". Send: it appears without a refresh.

Watch the frames: browser DevTools → Network → WS → click the connection →
Messages.

Stop the gateway (`docker compose stop gateway`): the status in the sidebar
changes to "Reconnecting…". Send a message from the other user via a third
window, start the gateway again, and the missed message appears after the
reconnect.

## Where it breaks

All connections live in one process's memory. Start a second gateway and a
user on gateway A never sees messages from a user on gateway B. → Phase 3

## Questions to be ready for

- WebSockets versus long polling versus Server-Sent Events: when would you pick each?
- How do you detect a dead connection? Why is the TCP layer not enough?
- What is backpressure and what happens without it?
- A gateway holding 50,000 connections restarts. What happens next, and how do you make that safe?
- How does a client recover messages it missed while offline?
