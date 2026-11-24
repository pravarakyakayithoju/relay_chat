import type {
  Channel,
  Member,
  Message,
  MessagePage,
  Notification,
  PublicUser,
  SearchHit,
  Workspace,
} from '@relay/shared';

const TOKEN_KEY = 'relay.token';

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Called when the server rejects our token, so the app can return to the login screen. */
let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && token) onUnauthorized();
    throw new ApiError(response.status, data?.error?.message ?? `Request failed (${response.status})`);
  }
  return data as T;
}

interface AuthResponse {
  token: string;
  user: PublicUser;
}

export const api = {
  signup: (username: string, email: string, password: string) =>
    request<AuthResponse>('POST', '/auth/signup', { username, email, password }),
  login: (email: string, password: string) =>
    request<AuthResponse>('POST', '/auth/login', { email, password }),
  me: () => request<PublicUser>('GET', '/me'),

  workspaces: () => request<{ workspaces: Workspace[] }>('GET', '/workspaces'),
  createWorkspace: (name: string) => request<Workspace>('POST', '/workspaces', { name }),
  joinWorkspace: (inviteCode: string) => request<Workspace>('POST', '/workspaces/join', { inviteCode }),
  members: (workspaceId: string) =>
    request<{ members: Member[] }>('GET', `/workspaces/${workspaceId}/members`),

  channels: (workspaceId: string) =>
    request<{ channels: Channel[] }>('GET', `/workspaces/${workspaceId}/channels`),
  createChannel: (workspaceId: string, name: string, isPrivate: boolean) =>
    request<Channel>('POST', `/workspaces/${workspaceId}/channels`, { name, isPrivate }),
  joinChannel: (channelId: string) => request<void>('POST', `/channels/${channelId}/join`),

  messages: (channelId: string, before?: string) =>
    request<MessagePage>(
      'GET',
      `/channels/${channelId}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    ),
  sendMessage: (channelId: string, content: string, clientMessageId: string) =>
    request<Message>('POST', `/channels/${channelId}/messages`, { content, clientMessageId }),
  markRead: (channelId: string, messageId: string) =>
    request<void>('POST', `/channels/${channelId}/read`, { messageId }),

  search: (workspaceId: string, q: string) =>
    request<{ hits: SearchHit[] }>(
      'GET',
      `/search?workspaceId=${workspaceId}&q=${encodeURIComponent(q)}`,
    ),

  notifications: () =>
    request<{ notifications: Notification[]; unread: number }>('GET', '/notifications'),
  markNotificationsRead: () => request<void>('POST', '/notifications/read'),
};

/**
 * Send a message, retrying on network errors and 5xx responses.
 *
 * Retrying a POST is normally dangerous (it might create the message twice).
 * It is safe here because every attempt carries the same clientMessageId and
 * the server treats that as an idempotency key.
 */
export async function sendMessageWithRetry(
  channelId: string,
  content: string,
  clientMessageId: string,
): Promise<Message> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await api.sendMessage(channelId, content, clientMessageId);
    } catch (err) {
      lastError = err;
      // 4xx means the request itself is wrong (too long, not a member, rate limited): retrying will not help.
      if (err instanceof ApiError && err.status < 500) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
    }
  }
  throw lastError;
}

/** UUID v4. crypto.randomUUID only exists on https and localhost, so fall back when it is missing. */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
