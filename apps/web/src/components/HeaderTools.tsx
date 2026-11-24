import type { Notification, SearchHit } from '@relay/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../api';

interface SearchProps {
  workspaceId: string;
  /** Called with the channel id of the chosen result. */
  onPick: (channelId: string) => void;
}

export function SearchBox({ workspaceId, onPick }: SearchProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setError(null);
    try {
      setHits((await api.search(workspaceId, query.trim())).hits);
    } catch (err) {
      setHits([]);
      setError((err as Error).message);
    }
  }

  return (
    <div className="popover-anchor">
      <form onSubmit={submit}>
        <input
          className="search"
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value) setHits(null);
          }}
          placeholder="Search messages"
          aria-label="Search messages"
        />
      </form>
      {hits && (
        <div className="popover">
          <div className="popover-title">
            {error ?? `${hits.length} result${hits.length === 1 ? '' : 's'}`}
            <button className="link" onClick={() => setHits(null)}>
              close
            </button>
          </div>
          {hits.map((hit) => (
            <button
              key={hit.messageId}
              className="hit"
              onClick={() => {
                onPick(hit.channelId);
                setHits(null);
              }}
            >
              <span className="muted">
                #{hit.channelName} · {hit.username} · {new Date(hit.createdAt).toLocaleString()}
              </span>
              <span>{hit.content}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface BellProps {
  unread: number;
  onOpened: () => void;
  onPick: (channelId: string) => void;
}

export function NotificationsBell({ unread, onOpened, onPick }: BellProps) {
  const [items, setItems] = useState<Notification[] | null>(null);

  async function toggle() {
    if (items) {
      setItems(null);
      return;
    }
    try {
      const result = await api.notifications();
      setItems(result.notifications);
      if (result.unread > 0) await api.markNotificationsRead();
      onOpened();
    } catch {
      setItems([]);
    }
  }

  return (
    <div className="popover-anchor">
      <button className="bell" onClick={toggle} aria-label={`Notifications, ${unread} unread`}>
        🔔{unread > 0 && <span className="badge">{unread}</span>}
      </button>
      {items && (
        <div className="popover right">
          <div className="popover-title">Mentions</div>
          {items.length === 0 && <p className="muted pad">Nobody has mentioned you yet.</p>}
          {items.map((item) => (
            <button
              key={item.id}
              className={`hit ${item.read ? '' : 'unread'}`}
              onClick={() => {
                onPick(item.channelId);
                setItems(null);
              }}
            >
              <span className="muted">
                {item.actorUsername} mentioned you · {new Date(item.createdAt).toLocaleString()}
              </span>
              <span>{item.preview}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
