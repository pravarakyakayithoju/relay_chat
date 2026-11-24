/**
 * Snowflake IDs: 64-bit, time-sortable, generated without a database round trip.
 *
 *   | 41 bits: ms since EPOCH | 10 bits: node id | 12 bits: sequence |
 *
 * Why not a SERIAL column? A sequence lives in one database, which becomes a
 * coordination point once messages are spread over partitions or shards.
 * Why not a UUID? Random UUIDs do not sort by time, and message history is
 * always read "newest first", so a time-ordered id doubles as the pagination
 * cursor and keeps inserts at the right-hand edge of the index.
 *
 * Each process needs its own node id (0-1023). Two processes sharing a node id
 * could mint the same id in the same millisecond; the primary key would reject
 * the second insert, so the failure is loud rather than silent.
 */

/** 2024-01-01T00:00:00Z. 41 bits of milliseconds lasts ~69 years from here. */
export const SNOWFLAKE_EPOCH_MS = 1704067200000;

const EPOCH = BigInt(SNOWFLAKE_EPOCH_MS);
const NODE_BITS = 10n;
const SEQ_BITS = 12n;
const MAX_NODE = (1 << 10) - 1;
const SEQ_MASK = (1n << SEQ_BITS) - 1n;
const MAX_INT64 = 9223372036854775807n;

export class Snowflake {
  private readonly nodeId: bigint;
  private lastMs = -1n;
  private seq = 0n;

  constructor(nodeId: number) {
    if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId > MAX_NODE) {
      throw new Error(`Snowflake node id must be an integer between 0 and ${MAX_NODE}`);
    }
    this.nodeId = BigInt(nodeId);
  }

  /** Returns the next id as a decimal string. `nowMs` is injectable for tests. */
  next(nowMs: number = Date.now()): string {
    let ms = BigInt(nowMs);
    // If the clock steps backwards (NTP adjustment), keep using the last
    // timestamp so ids never go backwards.
    if (ms < this.lastMs) ms = this.lastMs;

    if (ms === this.lastMs) {
      this.seq = (this.seq + 1n) & SEQ_MASK;
      // 4096 ids in one millisecond: borrow the next millisecond.
      if (this.seq === 0n) ms = this.lastMs + 1n;
    } else {
      this.seq = 0n;
    }
    this.lastMs = ms;

    const id = ((ms - EPOCH) << (NODE_BITS + SEQ_BITS)) | (this.nodeId << SEQ_BITS) | this.seq;
    return id.toString();
  }
}

/** Unix milliseconds encoded in a Snowflake id. */
export function snowflakeTimestamp(id: string): number {
  return Number((BigInt(id) >> (NODE_BITS + SEQ_BITS)) + EPOCH);
}

/** True if `value` is a decimal string that fits in a signed 64-bit integer. */
export function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,19}$/.test(value) && BigInt(value) <= MAX_INT64;
}

/** Stable 0-1023 node id derived from any string (hostname, pod name...). FNV-1a hash. */
export function nodeIdFromString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % (MAX_NODE + 1);
}
