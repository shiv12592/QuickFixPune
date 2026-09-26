const express = require('express');
const crypto = require('crypto');
const { pool, normalizeMobile, withTransaction } = require('../../db/pool');

const router = express.Router();

router.post('/register', async (req, res, next) => {
  const name = String(req.body.name || '').trim();
  const mobile = normalizeMobile(req.body.mobile);
  if (!name) {
    return res.status(400).json({ success: false, message: 'Customer name is required' });
  }
  if (name.length > 100) {
    return res.status(400).json({
      success: false,
      message: 'Customer name cannot exceed 100 characters'
    });
  }
  if (!mobile || !/^\+91[6-9]\d{9}$/.test(mobile)) {
    return res.status(400).json({
      success: false,
      message: 'Enter a valid 10-digit Indian mobile number'
    });
  }

  try {
    const customer = await withTransaction(async client => {
      const found = await client.query(
        `SELECT u.id, u.full_name, cp.public_id
         FROM users u LEFT JOIN customer_profiles cp ON cp.user_id = u.id
         WHERE u.mobile_e164 = $1
         FOR UPDATE OF u`,
        [mobile]
      );
      if (found.rowCount) {
        if (!found.rows[0].public_id) {
          const profile = await client.query(
            'INSERT INTO customer_profiles (user_id) VALUES ($1) RETURNING public_id',
            [found.rows[0].id]
          );
          found.rows[0].public_id = profile.rows[0].public_id;
        }
        return { ...found.rows[0], existed: true };
      }

      const userId = crypto.randomUUID();
      await client.query(
        'INSERT INTO users (id, mobile_e164, full_name) VALUES ($1, $2, $3)',
        [userId, mobile, name]
      );
      const created = await client.query(
        `INSERT INTO customer_profiles (user_id)
         VALUES ($1) RETURNING public_id`,
        [userId]
      );
      return {
        id: userId,
        full_name: name,
        public_id: created.rows[0].public_id,
        existed: false
      };
    });
    res.status(customer.existed ? 200 : 201).json({
      success: true,
      customer: {
        id: customer.public_id,
        public_id: customer.public_id,
        name: String(customer.full_name).trim().split(/\s+/)[0]
      }
    });
  } catch (error) {
    if (error.code === '23505') {
      try {
        const existing = await pool.query(
          `SELECT cp.public_id, u.full_name
           FROM users u JOIN customer_profiles cp ON cp.user_id = u.id
           WHERE u.mobile_e164 = $1`,
          [mobile]
        );
        if (existing.rowCount) {
          return res.json({
            success: true,
            customer: {
              id: existing.rows[0].public_id,
              public_id: existing.rows[0].public_id,
              name: String(existing.rows[0].full_name).trim().split(/\s+/)[0]
            }
          });
        }
      } catch (lookupError) {
        return next(lookupError);
      }
      return res.status(409).json({ success: false, message: 'Unable to create customer account' });
    }
    next(error);
  }
});

router.post('/otp/send', (_req, res) => {
  res.status(501).json({
    success: false,
    message: 'OTP delivery is not configured in this phase'
  });
});

router.post('/otp/verify', (_req, res) => {
  res.status(501).json({
    success: false,
    message: 'OTP verification is not configured in this phase'
  });
});

module.exports = router;
