const express = require('express');

const router = express.Router();

router.post('/register', (_req, res) => {
  res.status(410).json({
    success: false,
    message: 'Use mobile OTP sign-in to create or access a customer account'
  });
});

module.exports = router;
