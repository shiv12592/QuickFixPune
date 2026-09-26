const express = require('express');
const crypto = require('crypto');
const { pool, normalizeMobile, withTransaction } = require('../../db/pool');
const { requireProvider } = require('../../middleware/auth');

const router = express.Router();

function displayName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || '';
}

function cleanProvider(provider) {
  return {
    id: provider.public_id,
    public_id: provider.public_id,
    name: displayName(provider.full_name),
    service: provider.service,
    experience: provider.experience,
    area: provider.area,
    pincode: provider.pincode,
    verification_status: provider.verification_status,
    availability: provider.availability,
    created_at: provider.created_at
  };
}

function providerSql(where = '') {
  return `
    SELECT pp.public_id, u.full_name, pp.service, pp.experience, pp.area,
      pp.pincode, pp.verification_status, pp.availability, pp.created_at
    FROM provider_profiles pp
    JOIN users u ON u.id = pp.user_id
    ${where}
  `;
}

function publicOrLegacyId(alias) {
  return `(${alias}.public_id = $1 OR ${alias}.user_id = (
    SELECT target_id FROM legacy_record_map
    WHERE source_collection = 'providers' AND legacy_id = $1
  ))`;
}

router.get('/', async (req, res, next) => {
  const values = [];
  const filters = ["pp.verification_status = 'VERIFIED'"];
  if (req.query.service) {
    values.push(String(req.query.service).trim());
    filters.push(`lower(pp.service) = lower($${values.length})`);
  }
  if (req.query.pincode) {
    values.push(String(req.query.pincode).trim());
    filters.push(`pp.pincode = $${values.length}`);
  }
  if (req.query.area) {
    values.push(`%${String(req.query.area).trim()}%`);
    filters.push(`pp.area ILIKE $${values.length}`);
  }
  try {
    const result = await pool.query(
      `${providerSql(`WHERE ${filters.join(' AND ')}`)} ORDER BY pp.created_at DESC`,
      values
    );
    res.json({ success: true, providers: result.rows.map(cleanProvider) });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/dashboard', requireProvider, async (req, res, next) => {
  if (req.params.id !== req.auth.publicId) {
    return res.status(403).json({ success: false, message: 'This provider profile is not yours' });
  }
  try {
    const result = await pool.query(
      providerSql('WHERE pp.user_id = $1'),
      [req.auth.userId]
    );
    if (!result.rowCount) {
      return res.status(404).json({ success: false, message: 'Provider not found' });
    }
    res.json({ success: true, provider: cleanProvider(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      providerSql(`WHERE ${publicOrLegacyId('pp')} AND pp.verification_status = 'VERIFIED'`),
      [req.params.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ success: false, message: 'Provider not found' });
    }
    res.json({ success: true, provider: cleanProvider(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/availability', requireProvider, async (req, res, next) => {
  if (req.params.id !== req.auth.publicId) {
    return res.status(403).json({ success: false, message: 'This provider profile is not yours' });
  }
  const availability = String(req.body.availability || '').toUpperCase();
  if (!['AVAILABLE', 'BUSY', 'OFFLINE'].includes(availability)) {
    return res.status(400).json({
      success: false,
      message: 'Availability must be AVAILABLE, BUSY or OFFLINE'
    });
  }
  try {
    const result = await pool.query(
      `UPDATE provider_profiles pp
       SET availability = $1
       FROM users u
       WHERE pp.user_id = u.id AND pp.user_id = $2
       RETURNING pp.public_id, u.full_name, pp.service, pp.experience, pp.area,
         pp.pincode, pp.verification_status, pp.availability, pp.created_at`,
      [availability, req.auth.userId]
    );
    if (!result.rowCount) {
      return res.status(404).json({ success: false, message: 'Provider not found' });
    }
    res.json({ success: true, provider: cleanProvider(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

router.post('/register', async (req, res, next) => {
  const {
    name,
    mobile,
    service,
    experience,
    address,
    area,
    pincode
  } = req.body;
  const cleanName = String(name || '').trim();
  const cleanMobile = normalizeMobile(mobile);
  const cleanService = String(service || '').trim();
  const cleanAddress = String(address || '').trim();
  const cleanArea = String(area || '').trim();
  const cleanPincode = String(pincode || '').trim();
  const cleanExperience = Number(experience);

  if (!cleanName || !cleanService || !cleanAddress || !cleanArea) {
    return res.status(400).json({
      success: false,
      message: 'Name, service, address and area are required'
    });
  }
  if (
    cleanName.length > 100 || cleanService.length > 100 ||
    cleanAddress.length > 250 || cleanArea.length > 80
  ) {
    return res.status(400).json({
      success: false,
      message: 'Name, service, address or area is too long'
    });
  }
  if (!cleanMobile || !/^\+91[6-9]\d{9}$/.test(cleanMobile)) {
    return res.status(400).json({
      success: false,
      message: 'Enter a valid 10-digit Indian mobile number'
    });
  }
  if (!/^\d{6}$/.test(cleanPincode)) {
    return res.status(400).json({ success: false, message: 'Enter a valid 6-digit pincode' });
  }
  if (!Number.isInteger(cleanExperience) || cleanExperience < 0 || cleanExperience > 60) {
    return res.status(400).json({
      success: false,
      message: 'Experience must be a number between 0 and 60'
    });
  }

  try {
    const provider = await withTransaction(async client => {
      let userResult = await client.query(
        'SELECT id, full_name FROM users WHERE mobile_e164 = $1 FOR UPDATE',
        [cleanMobile]
      );
      let userId;
      if (userResult.rowCount) {
        userId = userResult.rows[0].id;
      } else {
        userId = crypto.randomUUID();
        await client.query(
          `INSERT INTO users (id, mobile_e164, full_name)
           VALUES ($1, $2, $3)`,
          [userId, cleanMobile, cleanName]
        );
      }
      const existing = await client.query(
        'SELECT 1 FROM provider_profiles WHERE user_id = $1',
        [userId]
      );
      if (existing.rowCount) {
        const error = new Error('A provider with this mobile number already exists');
        error.status = 409;
        throw error;
      }
      const result = await client.query(
        `INSERT INTO provider_profiles
           (user_id, service, experience, private_address, area, pincode)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING public_id, service, experience, area, pincode,
           verification_status, availability, created_at`,
        [userId, cleanService, cleanExperience, cleanAddress, cleanArea, cleanPincode]
      );
      return { ...result.rows[0], full_name: userResult.rows[0]?.full_name || cleanName };
    });
    res.status(201).json({
      success: true,
      message: 'Provider registration submitted for verification',
      provider: cleanProvider(provider)
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'A provider with this mobile number already exists'
      });
    }
    next(error);
  }
});

module.exports = router;
