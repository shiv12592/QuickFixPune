const express = require('express');
const crypto = require('crypto');
const { readDatabase, writeDatabase } = require('../database');

const router = express.Router();

function generateId() {
  return Date.now() + Math.floor(Math.random() * 10000);
}

function generatePaymentReference() {
  return 'QFPAY_' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

router.post('/create', (req, res) => {
  const {
    customerId,
    providerId,
    verificationToken
  } = req.body;

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

  const session = db.otp_sessions.find(
    item =>
      item.token === verificationToken &&
      String(item.customer_id) === String(customerId) &&
      item.verified === true
  );

  if (!session) {
    return res.status(403).json({
      success: false,
      message: 'Mobile number must be verified before payment'
    });
  }

  const provider = db.providers.find(
    item =>
      String(item.id) === String(providerId) &&
      item.verification_status === 'VERIFIED'
  );

  if (!provider) {
    return res.status(404).json({
      success: false,
      message: 'Verified provider not found'
    });
  }

  const existingLead = db.leads.find(
    lead =>
      String(lead.customer_id) === String(customerId) &&
      String(lead.provider_id) === String(providerId) &&
      lead.payment_status === 'PAID'
  );

  if (existingLead) {
    return res.json({
      success: true,
      already_paid: true,
      lead_id: existingLead.id,
      payment_reference: existingLead.payment_reference,
      amount: existingLead.amount
    });
  }

  const lead = {
    id: generateId(),
    customer_id: customer.id,
    provider_id: provider.id,
    amount: 20,
    currency: 'INR',
    payment_reference: generatePaymentReference(),
    payment_status: 'PENDING',
    created_at: new Date().toISOString()
  };

  db.leads.push(lead);
  writeDatabase(db);

  res.status(201).json({
    success: true,
    message: 'Payment order created',
    lead_id: lead.id,
    payment_reference: lead.payment_reference,
    amount: lead.amount,
    currency: lead.currency
  });
});

router.post('/pay-test', (req, res) => {
  const {
    leadId,
    verificationToken
  } = req.body;

  const db = readDatabase();

  const lead = db.leads.find(
    item => String(item.id) === String(leadId)
  );

  if (!lead) {
    return res.status(404).json({
      success: false,
      message: 'Lead not found'
    });
  }

  const session = db.otp_sessions.find(
    item =>
      item.token === verificationToken &&
      String(item.customer_id) === String(lead.customer_id) &&
      item.verified === true
  );

  if (!session) {
    return res.status(403).json({
      success: false,
      message: 'Verified customer session required'
    });
  }

  if (lead.payment_status === 'PAID') {
    return res.json({
      success: true,
      message: 'Payment already completed',
      lead_id: lead.id,
      payment_status: lead.payment_status
    });
  }

  lead.payment_status = 'PAID';
  lead.paid_at = new Date().toISOString();
  lead.payment_method = 'LOCAL_TEST';
  lead.payment_id = generatePaymentReference();

  writeDatabase(db);

  res.json({
    success: true,
    message: 'Test payment completed successfully',
    lead_id: lead.id,
    payment_status: 'PAID'
  });
});

router.post('/contact', (req, res) => {
  const {
    leadId,
    verificationToken
  } = req.body;

  const db = readDatabase();

  const lead = db.leads.find(
    item => String(item.id) === String(leadId)
  );

  if (!lead) {
    return res.status(404).json({
      success: false,
      message: 'Lead not found'
    });
  }

  const session = db.otp_sessions.find(
    item =>
      item.token === verificationToken &&
      String(item.customer_id) === String(lead.customer_id) &&
      item.verified === true
  );

  if (!session) {
    return res.status(403).json({
      success: false,
      message: 'Verified customer session required'
    });
  }

  if (lead.payment_status !== 'PAID') {
    return res.status(402).json({
      success: false,
      message: 'Payment required to unlock contact details'
    });
  }

  const provider = db.providers.find(
    item => String(item.id) === String(lead.provider_id)
  );

  if (!provider) {
    return res.status(404).json({
      success: false,
      message: 'Provider not found'
    });
  }

  res.json({
    success: true,
    message: 'Provider contact unlocked',
    provider: {
      id: provider.id,
      name: provider.name,
      mobile: provider.mobile,
      service: provider.service,
      area: provider.area,
      pincode: provider.pincode
    }
  });
});

module.exports = router;
