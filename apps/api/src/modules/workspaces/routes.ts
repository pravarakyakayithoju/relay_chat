import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, currentUser, uuidParam } from '../../lib/http';
import {
  assertWorkspaceMember,
  createWorkspace,
  joinWorkspace,
  listMembers,
  listWorkspaces,
} from './service';

const createSchema = z.object({ name: z.string().trim().min(1).max(80) });
const joinSchema = z.object({ inviteCode: z.string().trim().min(1).max(64) });

export const workspacesRouter = Router();

workspacesRouter.get(
  '/workspaces',
  asyncHandler(async (req, res) => {
    res.json({ workspaces: await listWorkspaces(currentUser(req).id) });
  }),
);

workspacesRouter.post(
  '/workspaces',
  asyncHandler(async (req, res) => {
    const { name } = createSchema.parse(req.body);
    res.status(201).json(await createWorkspace(currentUser(req), name));
  }),
);

workspacesRouter.post(
  '/workspaces/join',
  asyncHandler(async (req, res) => {
    const { inviteCode } = joinSchema.parse(req.body);
    res.json(await joinWorkspace(currentUser(req), inviteCode));
  }),
);

workspacesRouter.get(
  '/workspaces/:workspaceId/members',
  asyncHandler(async (req, res) => {
    const workspaceId = uuidParam(req, 'workspaceId');
    await assertWorkspaceMember(workspaceId, currentUser(req).id);
    res.json({ members: await listMembers(workspaceId) });
  }),
);
