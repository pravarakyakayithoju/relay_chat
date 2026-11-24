import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { asyncHandler, currentUser, messageIdSchema, uuidParam } from '../../lib/http';
import { rateLimit } from '../../middleware/rateLimit';
import { DEFAULT_PAGE_SIZE, listMessages, markRead, sendMessage } from './service';

const sendSchema = z.object({
  content: z.string().trim().min(1, 'message is empty').max(4000),
  clientMessageId: z.string().uuid().optional(),
});

const listSchema = z.object({
  before: messageIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
});

const readSchema = z.object({ messageId: messageIdSchema });

// Per user, not per IP: a whole office can share one IP address.
const sendLimiter = rateLimit({
  name: 'send',
  limit: config.sendRateLimitPer10s,
  windowMs: 10_000,
  key: (req) => req.user?.id ?? 'anonymous',
});

export const messagesRouter = Router();

messagesRouter.get(
  '/channels/:channelId/messages',
  asyncHandler(async (req, res) => {
    const channelId = uuidParam(req, 'channelId');
    const { before, limit } = listSchema.parse(req.query);
    res.json(await listMessages(currentUser(req), channelId, before ?? null, limit));
  }),
);

messagesRouter.post(
  '/channels/:channelId/messages',
  sendLimiter,
  asyncHandler(async (req, res) => {
    const channelId = uuidParam(req, 'channelId');
    const { content, clientMessageId } = sendSchema.parse(req.body);
    const { message, duplicate } = await sendMessage(
      currentUser(req),
      channelId,
      content,
      clientMessageId ?? null,
    );
    // 201 the first time, 200 when a retry was recognised and nothing new was created.
    res.status(duplicate ? 200 : 201).json(message);
  }),
);

messagesRouter.post(
  '/channels/:channelId/read',
  asyncHandler(async (req, res) => {
    const channelId = uuidParam(req, 'channelId');
    const { messageId } = readSchema.parse(req.body);
    await markRead(currentUser(req), channelId, messageId);
    res.status(204).end();
  }),
);
