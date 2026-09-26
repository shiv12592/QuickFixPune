require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { normalizeMobile } = require('../db/phone');

const root = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
};
const inputFile = path.resolve(root, option('--input') || 'database/quickfix.json');
const dryRunMode = args.includes('--dry-run');
const reportFile = path.resolve(
  root,
  option('--report') ||
    `database/migration-reports/postgres-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
);
const report = {
  input: path.relative(root, inputFile),
  mode: dryRunMode ? 'dry-run' : 'import',
  started_at: new Date().toISOString(),
  counts: {},
  duplicates: [],
  warnings: [],
  unmigrated: [],
  mappings: [],
  errors: []
};
const userIds = { customers: new Map(), providers: new Map() };
const conversationIds = new Map();
const legacyMapTypes = [
  'customers',
  'providers',
  'conversations',
  'service_requests',
  'messages'
];

function addIssue(collection, record, reason) {
  report.unmigrated.push({
    collection,
    legacy_id: record && record.id != null ? String(record.id) : null,
    reason
  });
}

function validTimestamp(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return date.toISOString();
}

function publicRef(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

function validIndianMobile(value) {
  const mobile = normalizeMobile(value);
  return /^\+91[6-9]\d{9}$/.test(mobile);
}

function loadJson() {
  const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Input database must contain a JSON object');
  }
  for (const collection of legacyMapTypes) {
    if (data[collection] != null && !Array.isArray(data[collection])) {
      throw new Error(`JSON collection "${collection}" must be an array`);
    }
    data[collection] = data[collection] || [];
  }
  data.otp_sessions = Array.isArray(data.otp_sessions) ? data.otp_sessions : [];
  data.leads = Array.isArray(data.leads) ? data.leads : [];
  data.bookings = Array.isArray(data.bookings) ? data.bookings : [];
  return data;
}

function writeReport() {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  report.finished_at = new Date().toISOString();
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w' });
  console.log(`Import report written to ${path.relative(root, reportFile)}`);
}

async function withSavepoint(client, collection, record, callback) {
  await client.query('SAVEPOINT import_record');
  try {
    const result = await callback();
    await client.query('RELEASE SAVEPOINT import_record');
    return result;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT import_record');
    await client.query('RELEASE SAVEPOINT import_record');
    addIssue(collection, record, error.message);
    return null;
  }
}

async function insertLegacyMap(client, collection, legacyId, targetId) {
  if (legacyId == null) return;
  await client.query(
    `INSERT INTO legacy_record_map (source_collection, legacy_id, target_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (source_collection, legacy_id) DO NOTHING`,
    [collection, String(legacyId), targetId]
  );
}

async function getLegacyMap(client, collection, legacyId) {
  if (legacyId == null) return null;
  const result = await client.query(
    `SELECT target_id FROM legacy_record_map
     WHERE source_collection = $1 AND legacy_id = $2`,
    [collection, String(legacyId)]
  );
  return result.rows[0]?.target_id || null;
}

async function ensureUser(client, record, collection, role) {
  const oldId = String(record.id);
  const priorMap = await getLegacyMap(client, collection, oldId);
  if (priorMap) {
    userIds[collection].set(oldId, priorMap);
    return priorMap;
  }

  const mobile = normalizeMobile(record.mobile) || null;
  const name = String(record.name || '').trim();
  if (!name) throw new Error('Missing full name');
  if (mobile && !/^\+91[6-9]\d{9}$/.test(mobile)) {
    throw new Error('Mobile number is not a valid Indian number after normalization');
  }
  if (role === 'CUSTOMER' && !mobile) {
    throw new Error('Customer has no valid mobile number');
  }
  if (!mobile && role === 'PROVIDER') {
    report.warnings.push({
      collection,
      legacy_id: oldId,
      reason: 'Provider has no valid mobile; migrated without phone and cannot use OTP until corrected'
    });
  }

  let user;
  if (mobile) {
    const existing = await client.query(
      'SELECT id, full_name FROM users WHERE mobile_e164 = $1 FOR UPDATE',
      [mobile]
    );
    user = existing.rows[0];
    if (user && user.full_name !== name) {
      report.warnings.push({
        collection,
        legacy_id: oldId,
        reason: 'Existing account with this phone has a different name; existing private name retained'
      });
    }
  }
  if (!user) {
    const id = crypto.randomUUID();
    const inserted = await client.query(
      `INSERT INTO users (id, mobile_e164, full_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4) RETURNING id, full_name`,
      [id, mobile, name, validTimestamp(record.created_at)]
    );
    user = inserted.rows[0];
  }

  if (role === 'CUSTOMER') {
    const existingProfile = await client.query(
      'SELECT user_id FROM customer_profiles WHERE user_id = $1',
      [user.id]
    );
    if (!existingProfile.rowCount) {
      await client.query(
        `INSERT INTO customer_profiles (user_id, created_at, updated_at)
         VALUES ($1, $2, $2)`,
        [user.id, validTimestamp(record.created_at)]
      );
    } else if (mobile) {
      report.duplicates.push({
        collection,
        legacy_id: oldId,
        duplicate_of_mobile: mobile,
        reason: 'Same normalized mobile already belongs to a customer account; linked to existing account'
      });
    }
  }
  if (role === 'CUSTOMER') {
    await insertLegacyMap(client, collection, oldId, user.id);
  }
  userIds[collection].set(oldId, user.id);
  return user.id;
}

async function importCustomers(client, data) {
  const seen = new Map();
  for (const row of data.customers) {
    await withSavepoint(client, 'customers', row, async () => {
      if (!row || row.id == null) throw new Error('Missing legacy customer ID');
      const mobile = normalizeMobile(row.mobile);
      if (mobile && seen.has(mobile)) {
        report.duplicates.push({
          collection: 'customers',
          legacy_id: String(row.id),
          duplicate_of_legacy_id: seen.get(mobile),
          mobile_e164: mobile
        });
      } else if (mobile) {
        seen.set(mobile, String(row.id));
      }
      await ensureUser(client, row, 'customers', 'CUSTOMER');
    });
  }
}

async function importProviders(client, data) {
  for (const row of data.providers) {
    await withSavepoint(client, 'providers', row, async () => {
      if (!row || row.id == null) throw new Error('Missing legacy provider ID');
      const userId = await ensureUser(client, row, 'providers', 'PROVIDER');
      userIds.providers.set(String(row.id), userId);
      const existing = await client.query(
        'SELECT public_id FROM provider_profiles WHERE user_id = $1',
        [userId]
      );
      if (existing.rowCount) {
        const alreadyMapped = await getLegacyMap(client, 'providers', row.id);
        if (alreadyMapped) {
          userIds.providers.set(String(row.id), userId);
          return;
        }
        report.duplicates.push({
          collection: 'providers',
          legacy_id: String(row.id),
          reason: 'Phone number is already attached to a different provider profile; source profile was not imported'
        });
        addIssue(
          'providers',
          row,
          'A different provider profile already uses this phone; resolve the conflict before import'
        );
        throw new Error('Duplicate provider mobile would discard a distinct provider profile');
      }
      const service = String(row.service || '').trim();
      const area = String(row.area || '').trim();
      const pincode = String(row.pincode || '').trim();
      const experience = Number(row.experience || 0);
      if (!service || !area || !/^\d{6}$/.test(pincode)) {
        throw new Error('Missing service/area or invalid six-digit pincode');
      }
      if (!String(row.address || '').trim()) {
        report.warnings.push({
          collection: 'providers',
          legacy_id: String(row.id),
          reason: 'Provider private address is missing in the JSON source'
        });
      }
      if (!Number.isInteger(experience) || experience < 0 || experience > 60) {
        throw new Error('Invalid provider experience');
      }
      const verification = String(row.verification_status || 'PENDING').toUpperCase();
      const availability = String(row.availability || (
        verification === 'VERIFIED' ? 'AVAILABLE' : 'OFFLINE'
      )).toUpperCase();
      if (!['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED'].includes(verification)) {
        throw new Error(`Unsupported verification status: ${verification}`);
      }
      if (!['AVAILABLE', 'BUSY', 'OFFLINE'].includes(availability)) {
        throw new Error(`Unsupported availability: ${availability}`);
      }
      await client.query(
        `INSERT INTO provider_profiles
           (user_id, service, experience, private_address, area, pincode,
            verification_status, availability, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [
          userId,
          service,
          experience,
          String(row.address || ''),
          area,
          pincode,
          verification,
          availability,
          validTimestamp(row.created_at)
        ]
      );
      await insertLegacyMap(client, 'providers', row.id, userId);
    });
  }
}

async function importConversations(client, data) {
  for (const row of data.conversations) {
    await withSavepoint(client, 'conversations', row, async () => {
      if (!row || row.id == null) throw new Error('Missing legacy conversation ID');
      const prior = await getLegacyMap(client, 'conversations', row.id);
      if (prior) {
        conversationIds.set(String(row.id), prior);
        return;
      }
      const customerId = userIds.customers.get(String(row.customer_id)) ||
        await getLegacyMap(client, 'customers', row.customer_id);
      const providerId = userIds.providers.get(String(row.provider_id)) ||
        await getLegacyMap(client, 'providers', row.provider_id);
      if (!customerId || !providerId) {
        throw new Error('Customer or provider could not be mapped');
      }
      const service = String(row.service || '').trim() || 'Service';
      const status = String(row.status || 'OPEN').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';
      const requestStatus = ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED']
        .includes(String(row.request_status || '').toUpperCase())
        ? String(row.request_status).toUpperCase()
        : 'PENDING';
      const id = crypto.randomUUID();
      const inserted = await client.query(
        `INSERT INTO conversations
           (id, public_id, reference, customer_id, provider_id, service,
            status, request_status, request_description, preferred_visit_time,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          id,
          publicRef('QF-CONV'),
          String(row.reference || publicRef('QF')),
          customerId,
          providerId,
          service,
          status,
          requestStatus,
          String(row.request_description || ''),
          String(row.preferred_visit_time || ''),
          validTimestamp(row.created_at),
          validTimestamp(row.updated_at || row.created_at)
        ]
      );
      conversationIds.set(String(row.id), inserted.rows[0].id);
      await insertLegacyMap(client, 'conversations', row.id, inserted.rows[0].id);
    });
  }
}

async function importServiceRequests(client, data) {
  for (const row of data.service_requests) {
    await withSavepoint(client, 'service_requests', row, async () => {
      if (!row || row.id == null) throw new Error('Missing legacy request ID');
      const prior = await getLegacyMap(client, 'service_requests', row.id);
      if (prior) return;
      const conversationId = conversationIds.get(String(row.conversation_id)) ||
        await getLegacyMap(client, 'conversations', row.conversation_id);
      const customerId = userIds.customers.get(String(row.customer_id)) ||
        await getLegacyMap(client, 'customers', row.customer_id);
      const providerId = userIds.providers.get(String(row.provider_id)) ||
        await getLegacyMap(client, 'providers', row.provider_id);
      if (!conversationId || !customerId || !providerId) {
        throw new Error('Conversation, customer, or provider could not be mapped');
      }
      const status = ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED']
        .includes(String(row.status || '').toUpperCase())
        ? String(row.status).toUpperCase()
        : 'PENDING';
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO service_requests
           (id, public_id, conversation_id, customer_id, provider_id,
            service, description, preferred_visit_time, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
        [
          id,
          publicRef('QF-REQ'),
          conversationId,
          customerId,
          providerId,
          String(row.service || 'Service'),
          String(row.description || ''),
          String(row.preferred_visit_time || ''),
          status,
          validTimestamp(row.created_at)
        ]
      );
      await client.query(
        `UPDATE conversations
         SET current_service_request_id = $2, request_status = $3,
             request_description = $4, preferred_visit_time = $5
         WHERE id = $1`,
        [
          conversationId,
          id,
          status,
          String(row.description || ''),
          String(row.preferred_visit_time || '')
        ]
      );
      await insertLegacyMap(client, 'service_requests', row.id, id);
    });
  }
}

async function importMessages(client, data) {
  for (const row of data.messages) {
    await withSavepoint(client, 'messages', row, async () => {
      if (!row || row.id == null) throw new Error('Missing legacy message ID');
      if (await getLegacyMap(client, 'messages', row.id)) return;
      const conversationId = conversationIds.get(String(row.conversation_id)) ||
        await getLegacyMap(client, 'conversations', row.conversation_id);
      const senderType = String(row.sender_type || '').toUpperCase();
      const senderId = senderType === 'CUSTOMER'
        ? userIds.customers.get(String(row.sender_id)) || await getLegacyMap(client, 'customers', row.sender_id)
        : senderType === 'PROVIDER'
          ? userIds.providers.get(String(row.sender_id)) || await getLegacyMap(client, 'providers', row.sender_id)
          : null;
      const text = String(row.message || '').trim();
      if (!conversationId || !senderId) {
        throw new Error('Conversation or sender could not be mapped');
      }
      if (!['CUSTOMER', 'PROVIDER'].includes(senderType)) {
        throw new Error('Unsupported message sender type');
      }
      const participants = await client.query(
        `SELECT customer_id, provider_id FROM conversations WHERE id = $1`,
        [conversationId]
      );
      const expectedSenderId = senderType === 'CUSTOMER'
        ? participants.rows[0]?.customer_id
        : participants.rows[0]?.provider_id;
      if (senderId !== expectedSenderId) {
        throw new Error('Message sender does not match conversation participants');
      }
      if (!text || text.length > 1000) throw new Error('Message is empty or exceeds 1000 characters');
      const createdAt = validTimestamp(row.created_at);
      const messageId = crypto.randomUUID();
      const messagePublicId = publicRef('QF-MSG');
      await client.query(
        `INSERT INTO messages
           (id, public_id, conversation_id, sender_id, sender_type,
            message, read_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          messageId,
          messagePublicId,
          conversationId,
          senderId,
          senderType,
          text,
          row.read ? validTimestamp(row.read_at || row.created_at) : null,
          createdAt
        ]
      );
      await insertLegacyMap(client, 'messages', row.id, messageId);
    });
  }
}

function createDryRunReport(data) {
  report.counts = Object.fromEntries(
    ['customers', 'providers', 'conversations', 'service_requests', 'messages']
      .map(collection => [collection, data[collection].length])
  );
  report.counts.otp_sessions_not_imported = data.otp_sessions.length;
  report.counts.payment_leads_not_imported = data.leads.length;
  report.counts.bookings = data.bookings.length;
  for (const collection of legacyMapTypes) {
    const seenIds = new Set();
    for (const record of data[collection]) {
      if (!record || record.id == null) continue;
      const legacyId = String(record.id);
      if (seenIds.has(legacyId)) {
        addIssue(collection, record, `Duplicate legacy ID "${legacyId}" prevents a safe mapping`);
      } else {
        seenIds.add(legacyId);
      }
    }
    const validateTimestamps = (collection, rows, fields) => {
      for (const record of rows) {
        if (!record || typeof record !== 'object') continue;
        for (const field of fields) {
          if (record[field] && Number.isNaN(new Date(record[field]).getTime())) {
            addIssue(collection, record, `Invalid ${field} timestamp`);
          }
        }
      }
    };
    validateTimestamps('customers', data.customers, ['created_at']);
    validateTimestamps('providers', data.providers, ['created_at']);
    validateTimestamps('conversations', data.conversations, ['created_at', 'updated_at']);
    validateTimestamps('service_requests', data.service_requests, ['created_at', 'updated_at']);
    validateTimestamps('messages', data.messages, ['created_at', 'read_at']);
  }
  const countStatuses = (rows, getStatus, defaultStatus) => rows.reduce((counts, row) => {
    const status = String(getStatus(row) || defaultStatus).toUpperCase();
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  report.source_summary = {
    provider_verification_statuses: countStatuses(
      data.providers,
      provider => provider?.verification_status,
      'PENDING'
    ),
    provider_availability: countStatuses(data.providers, provider =>
      provider?.availability || (
        String(provider?.verification_status || '').toUpperCase() === 'VERIFIED'
          ? 'AVAILABLE'
          : 'OFFLINE'
      ), 'OFFLINE'),
    conversations_by_status: countStatuses(data.conversations, row => row?.status, 'OPEN'),
    requests_by_status: countStatuses(data.service_requests, row => row?.status, 'PENDING'),
    messages_by_sender: countStatuses(data.messages, row => row?.sender_type, 'UNKNOWN'),
    messages_read: data.messages.filter(message => message && message.read).length,
    messages_unread: data.messages.filter(message => message && !message.read).length,
    providers: data.providers.map(provider => ({
      legacy_id: provider?.id == null ? null : String(provider.id),
      service: String(provider?.service || ''),
      verification_status: String(provider?.verification_status || 'PENDING').toUpperCase(),
      availability: String(provider?.availability || (
        String(provider?.verification_status || '').toUpperCase() === 'VERIFIED'
          ? 'AVAILABLE'
          : 'OFFLINE'
      )).toUpperCase()
    }))
  };
  const mobileToIds = new Map();
  for (const customer of data.customers) {
    if (!customer || typeof customer !== 'object') {
      addIssue('customers', customer, 'Customer record must be an object');
      continue;
    }
    const mobile = normalizeMobile(customer.mobile);
    if (customer.id == null) addIssue('customers', customer, 'Missing legacy customer ID');
    if (!String(customer?.name || '').trim()) addIssue('customers', customer, 'Missing customer full name');
    if (!validIndianMobile(customer?.mobile)) {
      addIssue('customers', customer, 'Missing or invalid Indian mobile number');
    }
    if (mobile && mobileToIds.has(mobile)) {
      report.duplicates.push({
        collection: 'customers',
        legacy_id: String(customer.id),
        duplicate_of_legacy_id: mobileToIds.get(mobile),
        mobile_e164: mobile
      });
    } else if (mobile) {
      mobileToIds.set(mobile, String(customer.id));
    }
  }
  const providerMobileToIds = new Map();
  for (const provider of data.providers) {
    if (!provider || typeof provider !== 'object') {
      addIssue('providers', provider, 'Provider record must be an object');
      continue;
    }
    const mobile = normalizeMobile(provider.mobile);
    if (provider.id == null) addIssue('providers', provider, 'Missing legacy provider ID');
    if (!String(provider.name || '').trim()) addIssue('providers', provider, 'Missing provider full name');
    if (!validIndianMobile(provider?.mobile)) {
      report.warnings.push({
        collection: 'providers',
        legacy_id: provider.id == null ? null : String(provider.id),
        reason: 'No valid mobile; may be imported without a phone and must be remediated before OTP login'
      });
      if (mobile) {
        addIssue('providers', provider, 'Mobile number is not a valid Indian number');
      }
    } else if (providerMobileToIds.has(mobile)) {
      const duplicate = {
        collection: 'providers',
        legacy_id: String(provider.id),
        duplicate_of_legacy_id: providerMobileToIds.get(mobile),
        mobile_e164: mobile,
        reason: 'Provider profiles sharing a phone cannot be safely merged automatically'
      };
      report.duplicates.push(duplicate);
      addIssue('providers', provider, duplicate.reason);
    } else {
      providerMobileToIds.set(mobile, String(provider.id));
    }
    if (!String(provider.address || '').trim()) {
      report.warnings.push({
        collection: 'providers',
        legacy_id: String(provider.id),
        reason: 'Private provider address is empty'
      });
    }
    if (!String(provider.service || '').trim() || !String(provider.area || '').trim() ||
        !/^\d{6}$/.test(String(provider.pincode || '').trim())) {
      addIssue('providers', provider, 'Missing service/area or invalid six-digit pincode');
    }
    const experience = Number(provider.experience || 0);
    if (!Number.isInteger(experience) || experience < 0 || experience > 60) {
      addIssue('providers', provider, 'Invalid provider experience');
    }
    const verification = String(provider.verification_status || 'PENDING').toUpperCase();
    if (!['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED'].includes(verification)) {
      addIssue('providers', provider, `Unsupported verification status: ${verification}`);
    }
    const availability = String(provider.availability || (
      verification === 'VERIFIED' ? 'AVAILABLE' : 'OFFLINE'
    )).toUpperCase();
    if (!['AVAILABLE', 'BUSY', 'OFFLINE'].includes(availability)) {
      addIssue('providers', provider, `Unsupported availability: ${availability}`);
    }
  }
  const customersById = new Set(data.customers.filter(Boolean).map(row => String(row.id)));
  const providersById = new Set(data.providers.filter(Boolean).map(row => String(row.id)));
  const conversationsById = new Map(
    data.conversations.filter(Boolean).map(row => [String(row.id), row])
  );
  for (const conversation of data.conversations) {
    if (!conversation || typeof conversation !== 'object') {
      addIssue('conversations', conversation, 'Conversation record must be an object');
      continue;
    }
    if (conversation.id == null) addIssue('conversations', conversation, 'Missing legacy conversation ID');
    if (!customersById.has(String(conversation.customer_id)) ||
        !providersById.has(String(conversation.provider_id))) {
      addIssue('conversations', conversation, 'Customer or provider reference does not exist');
    }
    if (!['OPEN', 'CLOSED'].includes(String(conversation.status || 'OPEN').toUpperCase())) {
      addIssue('conversations', conversation, `Unsupported conversation status: ${conversation.status}`);
    }
    if (!['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED']
      .includes(String(conversation.request_status || 'PENDING').toUpperCase())) {
      addIssue('conversations', conversation, `Unsupported conversation request status: ${conversation.request_status}`);
    }
  }
  for (const request of data.service_requests) {
    if (!request || typeof request !== 'object') {
      addIssue('service_requests', request, 'Service request record must be an object');
      continue;
    }
    const conversation = conversationsById.get(String(request.conversation_id));
    if (request.id == null) addIssue('service_requests', request, 'Missing legacy request ID');
    if (!conversation || !customersById.has(String(request.customer_id)) ||
        !providersById.has(String(request.provider_id))) {
      addIssue('service_requests', request, 'Conversation, customer, or provider reference does not exist');
    } else if (
      String(conversation.customer_id) !== String(request.customer_id) ||
      String(conversation.provider_id) !== String(request.provider_id)
    ) {
      addIssue('service_requests', request, 'Request participants do not match conversation participants');
    }
    if (request && !['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED']
      .includes(String(request.status || 'PENDING').toUpperCase())) {
      addIssue('service_requests', request, `Unsupported request status: ${request.status}`);
    }
  }
  for (const message of data.messages) {
    if (!message || typeof message !== 'object') {
      addIssue('messages', message, 'Message record must be an object');
      continue;
    }
    const conversation = conversationsById.get(String(message.conversation_id));
    if (message.id == null) addIssue('messages', message, 'Missing legacy message ID');
    const senderExists = String(message.sender_type).toUpperCase() === 'CUSTOMER'
      ? customersById.has(String(message.sender_id))
      : String(message.sender_type).toUpperCase() === 'PROVIDER'
        ? providersById.has(String(message.sender_id))
        : false;
    if (!conversation || !senderExists) {
      addIssue('messages', message, 'Conversation or sender reference does not exist');
      continue;
    }
    const senderMatches = String(message.sender_type).toUpperCase() === 'CUSTOMER'
      ? String(conversation.customer_id) === String(message.sender_id)
      : String(conversation.provider_id) === String(message.sender_id);
    if (!senderMatches) addIssue('messages', message, 'Sender is not a conversation participant');
    if (!String(message.message || '').trim() || String(message.message).length > 1000) {
      addIssue('messages', message, 'Message is empty or exceeds 1000 characters');
    }
  }
  report.notes = [
    'Dry run does not connect to PostgreSQL and does not allocate database IDs.',
    'OTP challenges and payment leads are intentionally not imported.',
    'Booking rows are not present in the current JSON schema; existing service_requests are imported separately.'
  ];
  report.import_blocked = report.unmigrated.length > 0;
  report.review_required = report.warnings.length > 0 || report.duplicates.length > 0;
}

async function main() {
  const data = loadJson();
  createDryRunReport(data);
  if (dryRunMode) {
    writeReport();
    return;
  }
  if (report.import_blocked) {
    throw new Error(
      `Import aborted before connecting: ${report.unmigrated.length} records are unmigratable; review the report`
    );
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Run npm run db:migrate before importing.');
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const schema = await client.query(
      `SELECT to_regclass('public.users') AS users,
              to_regclass('public.legacy_record_map') AS legacy_map`
    );
    if (!schema.rows[0].users || !schema.rows[0].legacy_map) {
      throw new Error('Required PostgreSQL schema is missing. Run npm run db:migrate first.');
    }
    await importCustomers(client, data);
    await importProviders(client, data);
    await importConversations(client, data);
    await importServiceRequests(client, data);
    await importMessages(client, data);
    if (report.unmigrated.length) {
      throw new Error(
        `Import aborted: ${report.unmigrated.length} source records could not be migrated; review the report`
      );
    }

    report.counts = {};
    for (const collection of legacyMapTypes) {
      const result = await client.query(
        'SELECT count(*)::int AS count FROM legacy_record_map WHERE source_collection = $1',
        [collection]
      );
      report.counts[collection] = result.rows[0].count;
    }
    report.counts.otp_sessions_not_imported = data.otp_sessions.length;
    report.counts.payment_leads_not_imported = data.leads.length;
    report.notes = [
      'Source JSON was read only and has not been deleted or modified.',
      'OTP challenge records and payment/unlock leads were intentionally not imported.',
      'Imports are idempotent by source collection and legacy ID.'
    ];
    report.mappings = (await client.query(
      `SELECT l.source_collection, l.legacy_id, l.target_id AS internal_uuid,
         COALESCE(cp.public_id, pp.public_id, c.public_id, sr.public_id, m.public_id) AS public_id
       FROM legacy_record_map l
       LEFT JOIN customer_profiles cp
         ON l.source_collection = 'customers' AND cp.user_id = l.target_id
       LEFT JOIN provider_profiles pp
         ON l.source_collection = 'providers' AND pp.user_id = l.target_id
       LEFT JOIN conversations c
         ON l.source_collection = 'conversations' AND c.id = l.target_id
       LEFT JOIN service_requests sr
         ON l.source_collection = 'service_requests' AND sr.id = l.target_id
       LEFT JOIN messages m
         ON l.source_collection = 'messages' AND m.id = l.target_id
       ORDER BY l.source_collection, l.legacy_id`
    )).rows;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    report.errors.push(error.message);
    throw error;
  } finally {
    await client.end();
  }
  writeReport();
}

main().catch(error => {
  report.errors.push(error.message);
  writeReport();
  console.error(error.message);
  process.exitCode = 1;
});
