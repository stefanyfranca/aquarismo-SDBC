const express = require("express");
const router = express.Router();
const controller = require("../controllers/executionController");

router.get("/current", controller.getCurrent);
router.post("/demo-start", controller.startDemo);
router.get("/:id/stream", controller.streamProgress);

module.exports = router;
