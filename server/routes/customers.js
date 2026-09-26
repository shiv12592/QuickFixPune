const express = require('express');
const crypto = require('crypto');
const { readDatabase, writeDatabase } = require('../database');

const router = express.Router();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeMobile(mobile) {
  return String(mobile || '').replace(/\D/g, '');
}

router.post('/register', (req, res) => {
  const { name, mobile } = req.body;

  const cleanName = String(name || '').trim();
  const cleanMobile = normalizeMobile(mobile);

  if (!cleanName) {
    return res.status(400).json({
      success: false,
      message: 'Customer name is required'
    });
  }

  if (cleanName.length > 100) {
    return res.status(400).json({
      success: false,
      message: 'Customer name cannot exceed 100 characters'
    });
  }

  if (!/^[6-9]\d{9}$/.test(cleanMobile)) {
    return res.status(400).json({
      success: false,
      message: 'Enter a valid 10-digit Indian mobile number'
    });
  }

  const db = readDatabase();

  const customer = {
    id: Date.now(),
    name: cleanName,
    mobile: cleanMobile,
    created_at: new Date().toISOString()
  };

  db.customers.push(customer);
  writeDatabase(db);

  res.status(201).json({
    success: true,
    customer: {
      id: customer.id,
      name: customer.name,
      mobile: customer.mobile
    }
  });
});

router.post('/otp/send', (req, res) => {
  const { customerId } = req.body;

  const db = readDatabase();
  const customer = db.customers.find(
    item => String(item.id) === String(customerId)
  );

  if (!customer) {
    return res.status(404).json({
      success: false,
      message: 'Customer not found'
    });
  }

  const otp = '123456';
  const token = generateToken();

  db.otp_sessions = db.otp_sessions.filter(
    session => String(session.customer_id) !== String(customerId)
  );

  db.otp_sessions.push({
    token,
    customer_id: customer.id,
    otp,
    verified: false,
    expires_at: Date.now() + 5 * 60 * 1000,
    created_at: new Date().toISOString()
  });

  writeDatabase(db);

  res.json({
    success: true,
    message: 'OTP sent successfully',
    verification_token: token,
    test_otp: otp
  });
});

router.post('/otp/verify', (req, res) => {
  const { verificationToken, otp } = req.body;

  const db = readDatabase();

  const session = db.otp_sessions.find(
    item => item.token === verificationToken
  );

  if (!session) {
    return res.status(400).json({
      success: false,
      message: 'Invalid OTP session'
    });
  }

  if (Date.now() > session.expires_at) {
    return res.status(400).json({
      success: false,
      message: 'OTP has expired'
    });
  }

  if (String(otp) !== session.otp) {
    return res.status(400).json({
      success: false,
      message: 'Invalid OTP'
    });
  }

  session.verified = true;
  session.verified_at = new Date().toISOString();

  writeDatabase(db);

  res.json({
    success: true,
    message: 'Mobile number verified',
    verification_token: verificationToken
  });
});

module.exports = router;
