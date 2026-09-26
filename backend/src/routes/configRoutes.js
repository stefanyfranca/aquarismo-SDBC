const express = require("express");
const router = express.Router();
const controller = require("../controllers/configController");

router.get("/", controller.getConfig);
router.put("/", controller.saveConfig);

module.exports = router;
