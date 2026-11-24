import type { Channel, Member, PublicUser, Workspace } from '@relay/shared';
import type { SocketStatus } from '../socket';

interface Props {
  user: PublicUser;
  status: SocketStatus;
  workspaces: Workspace[];
  workspace: Workspace | null;
  channels: Channel[];
  channelId: string | null;
  members: Member[];
  onSelectWorkspace: (id: string) => void;
  onCreateWorkspace: () => void;
  onJoinWorkspace: () => void;
  onSelectChannel: (id: string) => void;
  onCreateChannel: () => void;
  onLogout: () => void;
}

const STATUS_LABEL: Record<SocketStatus, string> = {
  connecting: 'Connecting…',
  online: 'Live',
  offline: 'Reconnecting…',
};

export function Sidebar(props: Props) {
  const { workspace, channels, members } = props;
  const joined = channels.filter((c) => c.isMember);
  const browsable = channels.filter((c) => !c.isMember);

  return (
    <aside className="sidebar">
      <section>
        <div className="section-title">
          Workspace
          <span>
            <button className="icon" title="Create a workspace" onClick={props.onCreateWorkspace}>
              +
            </button>
            <button className="icon" title="Join with an invite code" onClick={props.onJoinWorkspace}>
              ⇥
            </button>
          </span>
        </div>
        {props.workspaces.length > 0 && (
          <select
            value={workspace?.id ?? ''}
            onChange={(e) => props.onSelectWorkspace(e.target.value)}
            aria-label="Workspace"
          >
            {props.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
        {workspace && (
          <p className="invite">
            Invite code: <code>{workspace.inviteCode}</code>
          </p>
        )}
      </section>

      {workspace && (
        <>
          <section>
            <div className="section-title">
              Channels
              <button className="icon" title="Create a channel" onClick={props.onCreateChannel}>
                +
              </button>
            </div>
            <ul>
              {joined.map((c) => (
                <li key={c.id}>
                  <button
                    className={`row ${c.id === props.channelId ? 'active' : ''} ${c.unread ? 'unread' : ''}`}
                    onClick={() => props.onSelectChannel(c.id)}
                  >
                    {c.isPrivate ? '🔒' : '#'} {c.name}
                  </button>
                </li>
              ))}
            </ul>
            {browsable.length > 0 && (
              <>
                <div className="section-title small">Other channels (click to join)</div>
                <ul>
                  {browsable.map((c) => (
                    <li key={c.id}>
                      <button className="row dim" onClick={() => props.onSelectChannel(c.id)}>
                        # {c.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="grow">
            <div className="section-title">
              Members ({members.filter((m) => m.online).length}/{members.length} online)
            </div>
            <ul>
              {members.map((m) => (
                <li key={m.id} className="member">
                  <span className={`dot ${m.online ? 'on' : ''}`} aria-label={m.online ? 'online' : 'offline'} />
                  {m.username}
                  {m.id === props.user.id && <span className="muted"> (you)</span>}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <footer>
        <span>
          <span className={`dot ${props.status === 'online' ? 'on' : ''}`} /> {STATUS_LABEL[props.status]}
        </span>
        <span>
          {props.user.username} ·{' '}
          <button className="link" onClick={props.onLogout}>
            Sign out
          </button>
        </span>
      </footer>
    </aside>
  );
}
