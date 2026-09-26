const express = require('express');
const { readDatabase, writeDatabase } = require('../database');

const router = express.Router();

function cleanProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    service: provider.service,
    experience: provider.experience,
    area: provider.area,
    pincode: provider.pincode,
    verification_status: provider.verification_status,
    created_at: provider.created_at
  };
}

/*
 * Public provider search.
 *
 * IMPORTANT:
 * Never return mobile number or full address here.
 * Contact details are unlocked only after successful payment.
 */
router.get('/', (req, res) => {
  const {
    service,
    pincode,
    area
  } = req.query;

  const db = readDatabase();

  let providers = db.providers.filter(
    provider => provider.verification_status === 'VERIFIED'
  );

  if (service) {
    const requestedService = String(service).trim().toLowerCase();

    providers = providers.filter(
      provider =>
        String(provider.service).trim().toLowerCase() === requestedService
    );
  }

  if (pincode) {
    providers = providers.filter(
      provider =>
        String(provider.pincode).trim() === String(pincode).trim()
    );
  }

  if (area) {
    const requestedArea = String(area).trim().toLowerCase();

    providers = providers.filter(
      provider =>
        String(provider.area).trim().toLowerCase().includes(requestedArea)
    );
  }

  res.json({
    success: true,
    providers: providers.map(cleanProvider)
  });
});

/*
 * Public provider profile.
 *
 * Mobile and full address are intentionally excluded.
 */
router.get('/:id', (req, res) => {
  const db = readDatabase();

  const provider = db.providers.find(
    item =>
      String(item.id) === String(req.params.id) &&
      item.verification_status === 'VERIFIED'
  );

  if (!provider) {
    return res.status(404).json({
      success: false,
      message: 'Provider not found'
    });
  }

  res.json({
    success: true,
    provider: cleanProvider(provider)
  });
});

/*
 * Provider registration.
 */
router.post('/register', (req, res) => {
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
  const cleanMobile = String(mobile || '').replace(/\D/g, '');
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

  if (!/^[6-9]\d{9}$/.test(cleanMobile)) {
    return res.status(400).json({
      success: false,
      message: 'Enter a valid 10-digit Indian mobile number'
    });
  }

  if (!/^\d{6}$/.test(cleanPincode)) {
    return res.status(400).json({
      success: false,
      message: 'Enter a valid 6-digit pincode'
    });
  }

  if (!Number.isFinite(cleanExperience) || cleanExperience < 0) {
    return res.status(400).json({
      success: false,
      message: 'Experience must be a valid number'
    });
  }

  const db = readDatabase();

  const duplicateMobile = db.providers.find(
    provider => provider.mobile === cleanMobile
  );

  if (duplicateMobile) {
    return res.status(409).json({
      success: false,
      message: 'A provider with this mobile number already exists'
    });
  }

  const provider = {
    id: Date.now(),
    name: cleanName,
    mobile: cleanMobile,
    service: cleanService,
    experience: cleanExperience,
    address: cleanAddress,
    area: cleanArea,
    pincode: cleanPincode,
    verification_status: 'PENDING',
    created_at: new Date().toISOString()
  };

  db.providers.push(provider);
  writeDatabase(db);

  res.status(201).json({
    success: true,
    message: 'Provider registration submitted for verification',
    provider: cleanProvider(provider)
  });
});

module.exports = router;
