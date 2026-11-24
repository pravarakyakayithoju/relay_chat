import type { Channel, Message, PublicUser } from '@relay/shared';
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, newId, sendMessageWithRetry } from '../api';
import type { RealtimeSocket } from '../socket';

interface Props {
  channel: Channel;
  user: PublicUser;
  socket: RealtimeSocket;
}

/** Message ids are decimal strings of 64-bit integers: compare by length, then text. */
function compareIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Merge messages into the list, de-duplicated by id and sorted oldest first.
 *
 * Every source goes through here - the first page, older pages, the response
 * to our own send, live events, and refetches after a reconnect - because the
 * same message routinely arrives twice (our own send comes back from the HTTP
 * response AND over the WebSocket). Merging by id makes the order of arrival
 * irrelevant.
 */
function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const message of incoming) byId.set(message.id, { ...byId.get(message.id), ...message });
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}

const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const TYPING_SEND_INTERVAL_MS = 2000;
const TYPING_SHOWN_MS = 4000;

export function ChannelView({ channel, user, socket }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [typing, setTyping] = useState<Record<string, { username: string; until: number }>>({});
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  /** Keep the view pinned to the newest message unless the user scrolled up to read. */
  const stickToBottom = useRef(true);
  /** Distance from the bottom to restore after older messages are added above. */
  const restoreFromBottom = useRef<number | null>(null);
  const lastTypingSentAt = useRef(0);

  // First page. (The parent gives this component a `key` per channel, so state starts empty.)
  useEffect(() => {
    let cancelled = false;
    api
      .messages(channel.id)
      .then((page) => {
        if (cancelled) return;
        setMessages((current) => mergeMessages(current, page.messages));
        setCursor(page.nextCursor);
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [channel.id]);

  // Live updates.
  useEffect(
    () =>
      socket.on((event) => {
        switch (event.type) {
          case 'message.new':
            if (event.message.channelId !== channel.id) return;
            setMessages((current) => mergeMessages(current, [event.message]));
            // Their message arrived, so they are no longer "typing".
            setTyping(({ [event.message.userId]: _done, ...rest }) => rest);
            break;
          case 'message.preview':
            if (event.channelId !== channel.id) return;
            setMessages((current) =>
              current.map((m) => (m.id === event.messageId ? { ...m, preview: event.preview } : m)),
            );
            break;
          case 'typing':
            if (event.channelId !== channel.id) return;
            setTyping((current) => ({
              ...current,
              [event.userId]: { username: event.username, until: Date.now() + TYPING_SHOWN_MS },
            }));
            break;
          case 'resync':
            // We were disconnected and may have missed messages: fetch the latest page and merge.
            api
              .messages(channel.id)
              .then((page) => setMessages((current) => mergeMessages(current, page.messages)))
              .catch(() => undefined);
            break;
        }
      }),
    [socket, channel.id],
  );

  // Forget "is typing" entries that were not renewed.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setTyping((current) => {
        const alive = Object.entries(current).filter(([, entry]) => entry.until > now);
        return alive.length === Object.keys(current).length ? current : Object.fromEntries(alive);
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Scroll handling runs after the DOM has the new messages but before the browser paints.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (restoreFromBottom.current !== null) {
      list.scrollTop = list.scrollHeight - restoreFromBottom.current;
      restoreFromBottom.current = null;
    } else if (stickToBottom.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages]);

  // Move the read marker to the newest message we are showing.
  const newestId = messages.length > 0 ? messages[messages.length - 1].id : null;
  useEffect(() => {
    if (newestId) api.markRead(channel.id, newestId).catch(() => undefined);
  }, [channel.id, newestId]);

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  }

  async function loadOlder() {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api.messages(channel.id, cursor);
      const list = listRef.current;
      if (list) restoreFromBottom.current = list.scrollHeight - list.scrollTop;
      setMessages((current) => mergeMessages(current, page.messages));
      setCursor(page.nextCursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }

  function onDraftChange(value: string) {
    setDraft(value);
    const now = Date.now();
    if (value && now - lastTypingSentAt.current > TYPING_SEND_INTERVAL_MS) {
      lastTypingSentAt.current = now;
      socket.send({ type: 'typing', channelId: channel.id });
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setDraft('');
    setError(null);
    stickToBottom.current = true;
    try {
      // One id for this message, reused on every retry, so it can never be stored twice.
      const message = await sendMessageWithRetry(channel.id, content, newId());
      setMessages((current) => mergeMessages(current, [message]));
    } catch (err) {
      setError(`Not sent: ${(err as Error).message}`);
      setDraft(content);
    }
  }

  const typingNames = Object.entries(typing)
    .filter(([userId]) => userId !== user.id)
    .map(([, entry]) => entry.username);

  return (
    <>
      <div className="messages" ref={listRef} onScroll={onScroll}>
        {cursor && (
          <button className="link load-older" onClick={loadOlder} disabled={loadingOlder}>
            {loadingOlder ? 'Loading…' : 'Load older messages'}
          </button>
        )}
        {loading && <p className="muted">Loading messages…</p>}
        {!loading && messages.length === 0 && <p className="muted">No messages yet. Say hello!</p>}

        {messages.map((message) => (
          <article key={message.id} className="message">
            <header>
              <strong>{message.username}</strong>
              <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
            </header>
            <p>{message.content}</p>
            {message.preview && (
              <a className="preview" href={message.preview.url} target="_blank" rel="noopener noreferrer">
                <strong>{message.preview.title ?? message.preview.url}</strong>
                {message.preview.description && <span>{message.preview.description}</span>}
              </a>
            )}
          </article>
        ))}
      </div>

      <div className="typing" aria-live="polite">
        {typingNames.length > 0 &&
          `${typingNames.join(', ')} ${typingNames.length === 1 ? 'is' : 'are'} typing…`}
      </div>
      {error && <p className="error composer-error">{error}</p>}

      <form className="composer" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder={`Message #${channel.name}  (use @username to mention someone)`}
          maxLength={4000}
          autoFocus
        />
        <button className="primary" type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </>
  );
}
