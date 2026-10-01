const { Router } = require('express');
const { getBackupConfig, saveBackupConfig } = require('../services/backup-execution.service');

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    res.json(await getBackupConfig());
  } catch (error) {
    next(error);
  }
});

router.put('/', async (req, res, next) => {
  try {
    res.json(await saveBackupConfig(req.body || {}));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
