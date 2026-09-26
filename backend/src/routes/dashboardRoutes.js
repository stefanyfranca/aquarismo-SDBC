const express = require("express");
const router = express.Router();
const controller = require("../controllers/dashboardController");

router.get("/summary", controller.getSummary);

module.exports = router;
