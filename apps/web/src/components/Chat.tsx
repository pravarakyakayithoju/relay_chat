import type { Channel, Member, PublicUser, Workspace } from '@relay/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getToken } from '../api';
import { RealtimeSocket, type SocketStatus } from '../socket';
import { ChannelView } from './ChannelView';
import { NotificationsBell, SearchBox } from './HeaderTools';
import { Sidebar } from './Sidebar';

interface Props {
  user: PublicUser;
  onLogout: () => void;
}

/** The signed-in app: owns the socket and the workspace/channel/member lists. */
export function Chat({ user, onLogout }: Props) {
  const socket = useMemo(() => new RealtimeSocket(), []);
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Refs let the socket listener read the latest selection without re-subscribing.
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;

  const report = useCallback((err: unknown) => setError((err as Error).message), []);

  const loadWorkspaces = useCallback(async () => {
    const { workspaces: list } = await api.workspaces();
    setWorkspaces(list);
    setWorkspaceId((current) =>
      current && list.some((w) => w.id === current) ? current : (list[0]?.id ?? null),
    );
  }, []);

  const loadChannels = useCallback(async (forWorkspace: string) => {
    const { channels: list } = await api.channels(forWorkspace);
    if (workspaceIdRef.current !== forWorkspace) return; // the user switched workspace meanwhile
    // The channel on screen is being read right now, so it is never "unread".
    setChannels(list.map((c) => (c.id === channelIdRef.current ? { ...c, unread: false } : c)));
    setChannelId((current) =>
      current && list.some((c) => c.id === current && c.isMember)
        ? current
        : (list.find((c) => c.isMember)?.id ?? null),
    );
  }, []);

  const loadMembers = useCallback(async (forWorkspace: string) => {
    const { members: list } = await api.members(forWorkspace);
    if (workspaceIdRef.current === forWorkspace) setMembers(list);
  }, []);

  // Open the real-time connection for as long as this component is mounted.
  useEffect(() => {
    const unsubscribe = socket.onStatus(setStatus);
    socket.start(getToken() ?? '');
    return () => {
      unsubscribe();
      socket.stop();
    };
  }, [socket]);

  useEffect(() => {
    loadWorkspaces().catch(report);
    api
      .notifications()
      .then((result) => setUnreadNotifications(result.unread))
      .catch(() => undefined);
  }, [loadWorkspaces, report]);

  useEffect(() => {
    setChannels([]);
    setMembers([]);
    setChannelId(null);
    if (!workspaceId) return;
    loadChannels(workspaceId).catch(report);
    loadMembers(workspaceId).catch(report);
  }, [workspaceId, loadChannels, loadMembers, report]);

  useEffect(
    () =>
      socket.on((event) => {
        const currentWorkspace = workspaceIdRef.current;
        switch (event.type) {
          case 'message.new':
            if (event.message.channelId !== channelIdRef.current) {
              setChannels((list) =>
                list.map((c) => (c.id === event.message.channelId ? { ...c, unread: true } : c)),
              );
            }
            break;
          case 'presence.update':
            setMembers((list) =>
              list.map((m) => (m.id === event.userId ? { ...m, online: event.status === 'online' } : m)),
            );
            break;
          case 'notification.new':
            setUnreadNotifications((count) => count + 1);
            break;
          case 'membership.changed':
          case 'resync':
            loadWorkspaces().catch(report);
            if (currentWorkspace) {
              loadChannels(currentWorkspace).catch(report);
              loadMembers(currentWorkspace).catch(report);
            }
            break;
          case 'channels.changed':
            if (event.workspaceId === currentWorkspace) loadChannels(currentWorkspace).catch(report);
            break;
          case 'members.changed':
            if (event.workspaceId === currentWorkspace) loadMembers(currentWorkspace).catch(report);
            break;
        }
      }),
    [socket, loadWorkspaces, loadChannels, loadMembers, report],
  );

  const selectChannel = useCallback(
    async (target: string) => {
      const channel = channels.find((c) => c.id === target);
      if (!channel) return;
      try {
        if (!channel.isMember) await api.joinChannel(target);
        setChannelId(target);
        setChannels((list) =>
          list.map((c) => (c.id === target ? { ...c, isMember: true, unread: false } : c)),
        );
      } catch (err) {
        report(err);
      }
    },
    [channels, report],
  );

  const createWorkspace = useCallback(async () => {
    const name = window.prompt('Workspace name');
    if (!name?.trim()) return;
    try {
      const workspace = await api.createWorkspace(name.trim());
      await loadWorkspaces();
      setWorkspaceId(workspace.id);
    } catch (err) {
      report(err);
    }
  }, [loadWorkspaces, report]);

  const joinWorkspace = useCallback(async () => {
    const code = window.prompt('Invite code');
    if (!code?.trim()) return;
    try {
      const workspace = await api.joinWorkspace(code.trim());
      await loadWorkspaces();
      setWorkspaceId(workspace.id);
    } catch (err) {
      report(err);
    }
  }, [loadWorkspaces, report]);

  const createChannel = useCallback(async () => {
    if (!workspaceId) return;
    const name = window.prompt('Channel name (lowercase, no spaces)');
    if (!name?.trim()) return;
    const isPrivate = window.confirm('Make it private? OK = private, Cancel = public');
    try {
      const channel = await api.createChannel(workspaceId, name.trim().toLowerCase(), isPrivate);
      await loadChannels(workspaceId);
      setChannelId(channel.id);
    } catch (err) {
      report(err);
    }
  }, [workspaceId, loadChannels, report]);

  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const channel = channels.find((c) => c.id === channelId && c.isMember) ?? null;

  return (
    <div className="app">
      <Sidebar
        user={user}
        status={status}
        workspaces={workspaces}
        workspace={workspace}
        channels={channels}
        channelId={channelId}
        members={members}
        onSelectWorkspace={setWorkspaceId}
        onCreateWorkspace={createWorkspace}
        onJoinWorkspace={joinWorkspace}
        onSelectChannel={selectChannel}
        onCreateChannel={createChannel}
        onLogout={onLogout}
      />

      <main className="main">
        <header className="topbar">
          <strong>{channel ? `# ${channel.name}` : 'Relay'}</strong>
          <div className="topbar-tools">
            {workspace && <SearchBox workspaceId={workspace.id} onPick={selectChannel} />}
            <NotificationsBell
              unread={unreadNotifications}
              onOpened={() => setUnreadNotifications(0)}
              onPick={selectChannel}
            />
          </div>
        </header>

        {error && (
          <div className="banner error" role="alert">
            {error}
            <button className="link" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}

        {channel ? (
          <ChannelView key={channel.id} channel={channel} user={user} socket={socket} />
        ) : (
          <div className="center muted">
            {workspaces.length === 0
              ? 'Create a workspace, or join one with an invite code, to get started.'
              : 'Pick a channel from the sidebar.'}
          </div>
        )}
      </main>
    </div>
  );
}
