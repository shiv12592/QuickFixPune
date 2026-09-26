const express = require('express');
const crypto = require('crypto');
const { pool, withTransaction } = require('../../db/pool');

const router = express.Router();

function displayName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || '';
}

function publicRef(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

async function findUserId(client, userType, publicId) {
  const table = userType === 'CUSTOMER' ? 'customer_profiles' :
    userType === 'PROVIDER' ? 'provider_profiles' : null;
  if (!table) return null;
  const collection = userType === 'CUSTOMER' ? 'customers' : 'providers';
  const result = await client.query(
    `SELECT user_id FROM ${table} WHERE public_id = $1
     UNION ALL
     SELECT user_id FROM ${table}
     WHERE user_id = (
       SELECT target_id FROM legacy_record_map
       WHERE source_collection = $2 AND legacy_id = $1
     )
     LIMIT 1`,
    [publicId, collection]
  );
  return result.rows[0]?.user_id || null;
}

async function findConversation(client, publicId) {
  const result = await client.query(
    `SELECT c.*, cp.public_id AS customer_public_id,
       cu.full_name AS customer_full_name,
       pp.public_id AS provider_public_id,
       pu.full_name AS provider_full_name,
       pp.availability AS provider_availability,
       pp.area AS provider_area,
       pp.service AS provider_service,
       sr.public_id AS request_public_id
     FROM conversations c
     JOIN customer_profiles cp ON cp.user_id = c.customer_id
     JOIN users cu ON cu.id = cp.user_id
     JOIN provider_profiles pp ON pp.user_id = c.provider_id
     JOIN users pu ON pu.id = pp.user_id
     LEFT JOIN service_requests sr ON sr.id = c.current_service_request_id
     WHERE c.public_id = $1 OR c.id = (
       SELECT target_id FROM legacy_record_map
       WHERE source_collection = 'conversations' AND legacy_id = $1
     )
     LIMIT 1`,
    [publicId]
  );
  return result.rows[0] || null;
}

function serializeConversation(row) {
  const {
    id,
    public_id,
    customer_id,
    provider_id,
    customer_public_id,
    provider_public_id,
    customer_full_name,
    provider_full_name,
    provider_availability,
    provider_area,
    provider_service,
    request_public_id,
    current_service_request_id,
    ...conversation
  } = row;
  return {
    ...conversation,
    id: public_id,
    customer_id: customer_public_id,
    provider_id: provider_public_id,
    request_id: request_public_id || null,
    customer: { id: customer_public_id, name: displayName(customer_full_name) },
    provider: {
      id: provider_public_id,
      name: displayName(provider_full_name),
      service: provider_service,
      area: provider_area,
      availability: provider_availability
    }
  };
}

async function loadMessages(client, conversationId) {
  const result = await client.query(
    `SELECT m.public_id AS id, c.public_id AS conversation_id, m.sender_type,
       CASE
         WHEN m.sender_type = 'CUSTOMER' THEN cp.public_id
         ELSE pp.public_id
       END AS sender_id,
       m.message, (m.read_at IS NOT NULL) AS read,
       m.read_at, m.created_at
     FROM messages m
     LEFT JOIN customer_profiles cp
       ON m.sender_type = 'CUSTOMER' AND cp.user_id = m.sender_id
     LEFT JOIN provider_profiles pp
       ON m.sender_type = 'PROVIDER' AND pp.user_id = m.sender_id
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.conversation_id = $1
     ORDER BY m.created_at, m.id`,
    [conversationId]
  );
  return result.rows;
}

async function persistSocketMessage(conversationPublicId, senderType, senderPublicId, message) {
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage) throw new Error('Message cannot be empty');
  if (cleanMessage.length > 1000) throw new Error('Message cannot exceed 1000 characters');
  return withTransaction(async client => {
    const conversation = await findConversation(client, conversationPublicId);
    if (!conversation || conversation.status === 'CLOSED') {
      throw new Error('Conversation not found or closed');
    }
    const senderUserId = await findUserId(client, senderType, senderPublicId);
    if (
      !senderUserId ||
      (senderType === 'CUSTOMER' && senderUserId !== conversation.customer_id) ||
      (senderType === 'PROVIDER' && senderUserId !== conversation.provider_id)
    ) {
      throw new Error('You are not a participant in this conversation');
    }
    const result = await client.query(
      `INSERT INTO messages
         (id, public_id, conversation_id, sender_id, sender_type, message)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING public_id AS id, sender_type, message, created_at, read_at`,
      [crypto.randomUUID(), publicRef('QF-MSG'), conversation.id, senderUserId, senderType, cleanMessage]
    );
    await client.query(
      'UPDATE conversations SET updated_at = now() WHERE id = $1',
      [conversation.id]
    );
    return {
      ...result.rows[0],
      conversation_id: conversationPublicId,
      sender_id: senderPublicId,
      read: false
    };
  });
}

async function listConversations(req, res, next, userType) {
  try {
    const publicId = req.params[`${userType.toLowerCase()}Id`];
    const userId = await findUserId(pool, userType, publicId);
    if (!userId) {
      return res.status(404).json({
        success: false,
        message: userType === 'CUSTOMER' ? 'Customer not found' : 'Provider not found'
      });
    }
    const column = userType === 'CUSTOMER' ? 'customer_id' : 'provider_id';
    const result = await pool.query(
      `SELECT c.*, cp.public_id AS customer_public_id,
         cu.full_name AS customer_full_name, pp.public_id AS provider_public_id,
         pu.full_name AS provider_full_name, pp.availability AS provider_availability,
         pp.area AS provider_area, pp.service AS provider_service,
         sr.public_id AS request_public_id,
         (SELECT count(*)::int FROM messages m
          WHERE m.conversation_id = c.id
            AND m.sender_type <> $2 AND m.read_at IS NULL) AS unread_count
       FROM conversations c
       JOIN customer_profiles cp ON cp.user_id = c.customer_id
       JOIN users cu ON cu.id = cp.user_id
       JOIN provider_profiles pp ON pp.user_id = c.provider_id
       JOIN users pu ON pu.id = pp.user_id
       LEFT JOIN service_requests sr ON sr.id = c.current_service_request_id
       WHERE c.${column} = $1`,
      [userId, userType]
    );
    const conversations = await Promise.all(result.rows.map(async row => ({
      ...serializeConversation(row),
      messages: await loadMessages(pool, row.id),
      unread_count: row.unread_count
    })));
    res.json({ success: true, conversations });
  } catch (error) {
    next(error);
  }
}

router.post('/conversations', async (req, res, next) => {
  const {
    customerId,
    providerId,
    service,
    initialMessage,
    preferredVisitTime
  } = req.body;
  const message = String(initialMessage || '').trim();
  const visitTime = String(preferredVisitTime || '').trim();
  const requestedService = String(service || '').trim();
  if (!message) {
    return res.status(400).json({ success: false, message: 'A request description is required' });
  }
  if (message.length > 1000) {
    return res.status(400).json({ success: false, message: 'Message cannot exceed 1000 characters' });
  }
  if (visitTime.length > 100) {
    return res.status(400).json({
      success: false,
      message: 'Preferred visit time cannot exceed 100 characters'
    });
  }
  if (requestedService.length > 100) {
    return res.status(400).json({ success: false, message: 'Service name cannot exceed 100 characters' });
  }

  try {
    const conversation = await withTransaction(async client => {
      const customerIdResult = await findUserId(client, 'CUSTOMER', customerId);
      if (!customerIdResult) {
        const error = new Error('Customer not found');
        error.status = 404;
        throw error;
      }
      const providerResult = await client.query(
        `SELECT pp.user_id, pp.service, pp.public_id
         FROM provider_profiles pp
         WHERE (pp.public_id = $1 OR pp.user_id = (
           SELECT target_id FROM legacy_record_map
           WHERE source_collection = 'providers' AND legacy_id = $1
         )) AND pp.verification_status = 'VERIFIED'`,
        [providerId]
      );
      if (!providerResult.rowCount) {
        const error = new Error('Verified provider not found');
        error.status = 404;
        throw error;
      }
      const provider = providerResult.rows[0];
      if (requestedService && requestedService.toLowerCase() !== provider.service.trim().toLowerCase()) {
        const error = new Error('The selected provider does not offer this service');
        error.status = 400;
        throw error;
      }

      let conversationResult = await client.query(
        `SELECT id, public_id, reference, service, status, created_at, updated_at
        FROM conversations
         WHERE customer_id = $1 AND provider_id = $2 AND status <> 'CLOSED'
         ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
        [customerIdResult, provider.user_id]
      );
      let current = conversationResult.rows[0];
      if (!current) {
        const inserted = await client.query(
          `INSERT INTO conversations
             (id, public_id, reference, customer_id, provider_id, service)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, public_id, reference, service, status, created_at, updated_at`,
          [
            crypto.randomUUID(),
            publicRef('QF-CONV'),
            `QF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
            customerIdResult,
            provider.user_id,
            provider.service
          ]
        );
        current = inserted.rows[0];
      }
      const requestResult = await client.query(
        `INSERT INTO service_requests
           (id, public_id, conversation_id, customer_id, provider_id,
            service, description, preferred_visit_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, public_id, status, created_at`,
        [
          crypto.randomUUID(),
          publicRef('QF-REQ'),
          current.id,
          customerIdResult,
          provider.user_id,
          current.service,
          message,
          visitTime
        ]
      );
      await client.query(
        `UPDATE conversations SET current_service_request_id = $2,
           request_status = 'PENDING', request_description = $3,
           preferred_visit_time = $4, updated_at = now()
         WHERE id = $1`,
        [current.id, requestResult.rows[0].id, message, visitTime]
      );
      const messageResult = await client.query(
        `INSERT INTO messages
           (id, public_id, conversation_id, sender_id, sender_type, message)
         VALUES ($1, $2, $3, $4, 'CUSTOMER', $5)
         RETURNING public_id, message, created_at, read_at`,
        [crypto.randomUUID(), publicRef('QF-MSG'), current.id, customerIdResult, message]
      );
      const customerPublic = await client.query(
        'SELECT public_id FROM customer_profiles WHERE user_id = $1',
        [customerIdResult]
      );
      return {
        id: current.public_id,
        public_id: current.public_id,
        reference: current.reference,
        customer_id: customerPublic.rows[0].public_id,
        provider_id: provider.public_id,
        service: current.service,
        status: current.status,
        request_id: requestResult.rows[0].public_id,
        request_status: requestResult.rows[0].status,
        request_description: message,
        preferred_visit_time: visitTime,
        created_at: current.created_at || requestResult.rows[0].created_at,
        updated_at: messageResult.rows[0].created_at
      };
    });
    res.status(201).json({ success: true, conversation });
  } catch (error) {
    next(error);
  }
});

router.get('/conversations/customer/:customerId', (req, res, next) =>
  listConversations(req, res, next, 'CUSTOMER'));

router.get('/conversations/provider/:providerId', (req, res, next) =>
  listConversations(req, res, next, 'PROVIDER'));

router.get('/conversations/:conversationId/messages', async (req, res, next) => {
  const { userType, userId } = req.query;
  try {
    const conversation = await findConversation(pool, req.params.conversationId);
    if (!conversation) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }
    const participantId = await findUserId(pool, String(userType || '').toUpperCase(), userId);
    if (
      !participantId ||
      (String(userType).toUpperCase() === 'CUSTOMER' && participantId !== conversation.customer_id) ||
      (String(userType).toUpperCase() === 'PROVIDER' && participantId !== conversation.provider_id)
    ) {
      return res.status(403).json({
        success: false,
        message: 'You are not a participant in this conversation'
      });
    }
    res.json({
      success: true,
      conversation: serializeConversation(conversation),
      messages: await loadMessages(pool, conversation.id)
    });
  } catch (error) {
    next(error);
  }
});

router.post('/conversations/:conversationId/messages', async (req, res, next) => {
  const senderType = String(req.body.senderType || '').toUpperCase();
  const senderId = req.body.senderId;
  const message = String(req.body.message || '').trim();
  if (!message) {
    return res.status(400).json({ success: false, message: 'Message cannot be empty' });
  }
  if (message.length > 1000) {
    return res.status(400).json({ success: false, message: 'Message cannot exceed 1000 characters' });
  }
  try {
    const created = await persistSocketMessage(
      req.params.conversationId,
      senderType,
      senderId,
      message
    );
    res.status(201).json({ success: true, message: created });
  } catch (error) {
    if (error.message === 'Conversation not found or closed') error.status = 404;
    if (error.message === 'You are not a participant in this conversation') error.status = 403;
    next(error);
  }
});

router.post('/conversations/:conversationId/read', async (req, res, next) => {
  const userType = String(req.body.userType || '').toUpperCase();
  try {
    const conversation = await findConversation(pool, req.params.conversationId);
    if (!conversation) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }
    const userId = await findUserId(pool, userType, req.body.userId);
    if (
      !userId ||
      (userType === 'CUSTOMER' && userId !== conversation.customer_id) ||
      (userType === 'PROVIDER' && userId !== conversation.provider_id)
    ) {
      return res.status(403).json({
        success: false,
        message: 'You are not a participant in this conversation'
      });
    }
    await pool.query(
      `UPDATE messages SET read_at = now()
       WHERE conversation_id = $1 AND sender_type <> $2 AND read_at IS NULL`,
      [conversation.id, userType]
    );
    res.json({ success: true, message: 'Messages marked as read' });
  } catch (error) {
    next(error);
  }
});

module.exports = {
  router,
  findUserId,
  findConversation,
  loadMessages,
  publicRef,
  persistSocketMessage
};
