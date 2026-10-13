// The message-tag summary the mail list and the message view read (./index.js), mounted at
// /api/message-tags.
//
//   POST /summary { ids: string[] } -> { tags: { [messageId]: { notable, sources } } }
//
// Only the caller's own messages are answered, and only from what the tag plugins have stored:
// nothing here queries a reputation source. The display preference lives with the other user
// preferences, not here.
import { Router } from 'express';
import { requireAuth } from '../../src/middleware/auth.js';
import { summarizeForUser } from './index.js';

const router = Router();
router.use(requireAuth);

router.post('/summary', async (req, res) => {
  const result = await summarizeForUser(req.session.userId, req.body?.ids);
  switch (result.kind) {
    case 'ok':
      return res.json({ tags: result.tags });
    case 'invalid':
      return res.status(400).json({ error: result.error });
    default:
      throw new Error(`unhandled summary result ${result.kind}`);
  }
});

export default router;
