import { Router } from 'express';
import { requireAuth } from '../../src/middleware/auth.js';
import { inspectBackfills, startBackfills } from './index.js';

const router = Router();
router.use(requireAuth);
router.get('/', async (req, res) => res.json(await inspectBackfills(req.session.userId)));
router.post('/', async (req, res) => res.json(await startBackfills(req.session.userId)));
export default router;
