/**
 * The presence rule, kept free of imports so it can be unit-tested without Redis.
 *
 * `fields` is the Redis hash for one user: { connectionId -> last heartbeat in ms }.
 * A field that has not been refreshed within FRESH_MS belongs to a connection
 * whose gateway died without cleaning up, and no longer counts.
 */
export const FRESH_MS = 75_000;

export function hasFreshConnection(fields: Record<string, string>, now: number): boolean {
  return Object.values(fields).some((ts) => now - Number(ts) < FRESH_MS);
}
