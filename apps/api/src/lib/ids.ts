import { Snowflake } from '@relay/shared';
import { config } from '../config';

/** One generator per process. See packages/shared/src/snowflake.ts for the format. */
const generator = new Snowflake(config.nodeId);

export function nextMessageId(): string {
  return generator.next();
}
