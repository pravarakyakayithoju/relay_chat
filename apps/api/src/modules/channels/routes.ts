import { Router } from 'express';
import { z } from 'zod';
import { CHANNEL_NAME_PATTERN, USERNAME_PATTERN } from '@relay/shared';
import { asyncHandler, currentUser, uuidParam } from '../../lib/http';
import {
  addChannelMember,
  createChannel,
  joinChannel,
  leaveChannel,
  listChannels,
} from './service';

const createSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(CHANNEL_NAME_PATTERN, 'use 1-40 lowercase letters, digits, dashes or underscores'),
  isPrivate: z.boolean().default(false),
});

const addMemberSchema = z.object({
  username: z.string().trim().toLowerCase().regex(USERNAME_PATTERN),
});

export const channelsRouter = Router();

channelsRouter.get(
  '/workspaces/:workspaceId/channels',
  asyncHandler(async (req, res) => {
    const workspaceId = uuidParam(req, 'workspaceId');
    res.json({ channels: await listChannels(workspaceId, currentUser(req).id) });
  }),
);

channelsRouter.post(
  '/workspaces/:workspaceId/channels',
  asyncHandler(async (req, res) => {
    const workspaceId = uuidParam(req, 'workspaceId');
    const { name, isPrivate } = createSchema.parse(req.body);
    res.status(201).json(await createChannel(currentUser(req), workspaceId, name, isPrivate));
  }),
);

channelsRouter.post(
  '/channels/:channelId/join',
  asyncHandler(async (req, res) => {
    await joinChannel(currentUser(req), uuidParam(req, 'channelId'));
    res.status(204).end();
  }),
);

channelsRouter.post(
  '/channels/:channelId/leave',
  asyncHandler(async (req, res) => {
    await leaveChannel(currentUser(req), uuidParam(req, 'channelId'));
    res.status(204).end();
  }),
);

channelsRouter.post(
  '/channels/:channelId/members',
  asyncHandler(async (req, res) => {
    const { username } = addMemberSchema.parse(req.body);
    await addChannelMember(currentUser(req), uuidParam(req, 'channelId'), username);
    res.status(204).end();
  }),
);
