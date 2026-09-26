const express = require('express');
const crypto = require('crypto');
const { readDatabase, writeDatabase } = require('../database');

const router = express.Router();

function generateId() {
  return Date.now() + Math.floor(Math.random() * 10000);
}

function generateConversationReference() {
  return 'QF-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

/*
 * Start a conversation between customer and provider.
 */
router.post('/conversations', (req, res) => {
  const {
    customerId,
    providerId,
    service,
    initialMessage,
    preferredVisitTime
  } = req.body;

  const cleanMessage = String(initialMessage || '').trim();
  const cleanPreferredVisitTime = String(preferredVisitTime || '').trim();
  const requestedService = String(service || '').trim();

  if (!cleanMessage) {
    return res.status(400).json({
      success: false,
      message: 'A request description is required'
    });
  }

  if (cleanMessage.length > 1000) {
    return res.status(400).json({
      success: false,
      message: 'Message cannot exceed 1000 characters'
    });
  }

  if (cleanPreferredVisitTime.length > 100) {
    return res.status(400).json({
      success: false,
      message: 'Preferred visit time cannot exceed 100 characters'
    });
  }

  if (requestedService.length > 100) {
    return res.status(400).json({
      success: false,
      message: 'Service name cannot exceed 100 characters'
    });
  }

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

  if (
    requestedService &&
    requestedService.toLowerCase() !== String(provider.service).trim().toLowerCase()
  ) {
    return res.status(400).json({
      success: false,
      message: 'The selected provider does not offer this service'
    });
  }

  let conversation = db.conversations.find(
    item =>
      String(item.customer_id) === String(customer.id) &&
      String(item.provider_id) === String(provider.id) &&
      item.status !== 'CLOSED'
  );

  if (!conversation) {
    conversation = {
      id: generateId(),
      reference: generateConversationReference(),
      customer_id: customer.id,
      provider_id: provider.id,
      service: provider.service,
      status: 'OPEN',
      request_status: 'PENDING',
      request_description: cleanMessage,
      preferred_visit_time: cleanPreferredVisitTime,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    db.conversations.push(conversation);
  }

  const request = {
    id: generateId(),
    conversation_id: conversation.id,
    customer_id: customer.id,
    provider_id: provider.id,
    service: conversation.service,
    description: cleanMessage,
    preferred_visit_time: cleanPreferredVisitTime,
    status: 'PENDING',
    created_at: new Date().toISOString()
  };
  db.service_requests.push(request);
  conversation.request_id = request.id;
  conversation.request_status = 'PENDING';
  conversation.request_description = cleanMessage;
  conversation.preferred_visit_time = cleanPreferredVisitTime;

  if (cleanMessage) {
    const message = {
      id: generateId(),
      conversation_id: conversation.id,
      sender_type: 'CUSTOMER',
      sender_id: customer.id,
      message: cleanMessage,
      read: false,
      created_at: new Date().toISOString()
    };

    db.messages.push(message);
    conversation.updated_at = message.created_at;
  }

  writeDatabase(db);

  res.status(201).json({
    success: true,
    conversation
  });
});

/*
 * Get customer conversations.
 */
router.get('/conversations/customer/:customerId', (req, res) => {
  const db = readDatabase();
  const customer = db.customers.find(
    item => String(item.id) === String(req.params.customerId)
  );

  if (!customer) {
    return res.status(404).json({
      success: false,
      message: 'Customer not found'
    });
  }

  const conversations = db.conversations
    .filter(
      item =>
        String(item.customer_id) === String(req.params.customerId)
    )
    .map(conversation => {
      const provider = db.providers.find(
        item => String(item.id) === String(conversation.provider_id)
      );

      const messages = db.messages
        .filter(
          message =>
            String(message.conversation_id) ===
            String(conversation.id)
        )
        .sort(
          (a, b) =>
            new Date(a.created_at) - new Date(b.created_at)
        );

      return {
        ...conversation,
        provider: provider
          ? {
              id: provider.id,
              name: provider.name,
              service: provider.service,
              area: provider.area,
              availability: provider.availability || 'AVAILABLE'
            }
          : null,
        messages,
        unread_count: messages.filter(
          message => message.sender_type === 'PROVIDER' && !message.read
        ).length
      };
    });

  res.json({
    success: true,
    conversations
  });
});

/*
 * Get provider conversations.
 */
router.get('/conversations/provider/:providerId', (req, res) => {
  const db = readDatabase();
  const provider = db.providers.find(
    item => String(item.id) === String(req.params.providerId)
  );

  if (!provider) {
    return res.status(404).json({
      success: false,
      message: 'Provider not found'
    });
  }

  const conversations = db.conversations
    .filter(
      item =>
        String(item.provider_id) === String(req.params.providerId)
    )
    .map(conversation => {
      const customer = db.customers.find(
        item => String(item.id) === String(conversation.customer_id)
      );

      const messages = db.messages
        .filter(
          message =>
            String(message.conversation_id) ===
            String(conversation.id)
        )
        .sort(
          (a, b) =>
            new Date(a.created_at) - new Date(b.created_at)
        );

      return {
        ...conversation,
        customer: customer
          ? {
              id: customer.id,
              name: customer.name
            }
          : null,
        messages,
        unread_count: messages.filter(
          message => message.sender_type === 'CUSTOMER' && !message.read
        ).length
      };
    });

  res.json({
    success: true,
    conversations
  });
});

/*
 * Get messages for one conversation.
 */
router.get('/conversations/:conversationId/messages', (req, res) => {
  const { userType, userId } = req.query;
  const db = readDatabase();

  const conversation = db.conversations.find(
    item =>
      String(item.id) === String(req.params.conversationId)
  );

  if (!conversation) {
    return res.status(404).json({
      success: false,
      message: 'Conversation not found'
    });
  }

  if (!isConversationParticipant(conversation, userType, userId)) {
    return res.status(403).json({
      success: false,
      message: 'You are not a participant in this conversation'
    });
  }

  const messages = db.messages
    .filter(
      message =>
        String(message.conversation_id) ===
        String(conversation.id)
    )
    .sort(
      (a, b) =>
        new Date(a.created_at) - new Date(b.created_at)
    );

  res.json({
    success: true,
    conversation: {
      ...conversation,
      provider: (() => {
        const provider = db.providers.find(
          item => String(item.id) === String(conversation.provider_id)
        );
        return provider ? {
          id: provider.id,
          name: provider.name,
          service: provider.service,
          area: provider.area,
          availability: provider.availability || 'AVAILABLE'
        } : null;
      })(),
      customer: (() => {
        const customer = db.customers.find(
          item => String(item.id) === String(conversation.customer_id)
        );
        return customer ? { id: customer.id, name: customer.name } : null;
      })()
    },
    messages
  });
});

/*
 * Send a message.
 */
router.post('/conversations/:conversationId/messages', (req, res) => {
  const {
    senderType,
    senderId,
    message
  } = req.body;

  const db = readDatabase();

  const conversation = db.conversations.find(
    item =>
      String(item.id) === String(req.params.conversationId) &&
      item.status !== 'CLOSED'
  );

  if (!conversation) {
    return res.status(404).json({
      success: false,
      message: 'Conversation not found or closed'
    });
  }

  const cleanMessage = String(message || '').trim();

  if (!cleanMessage) {
    return res.status(400).json({
      success: false,
      message: 'Message cannot be empty'
    });
  }

  if (cleanMessage.length > 1000) {
    return res.status(400).json({
      success: false,
      message: 'Message cannot exceed 1000 characters'
    });
  }

  const normalizedSenderType =
    String(senderType || '').toUpperCase();

  if (!isConversationParticipant(conversation, normalizedSenderType, senderId)) {
    return res.status(403).json({
      success: false,
      message: 'You are not a participant in this conversation'
    });
  }

  const newMessage = {
    id: generateId(),
    conversation_id: conversation.id,
    sender_type: normalizedSenderType,
    sender_id: senderId,
    message: cleanMessage,
    read: false,
    created_at: new Date().toISOString()
  };

  db.messages.push(newMessage);

  conversation.updated_at = newMessage.created_at;

  writeDatabase(db);

  res.status(201).json({
    success: true,
    message: newMessage
  });
});

/*
 * Mark messages as read.
 */
router.post('/conversations/:conversationId/read', (req, res) => {
  const {
    userType,
    userId
  } = req.body;

  const db = readDatabase();

  const conversation = db.conversations.find(
    item =>
      String(item.id) === String(req.params.conversationId)
  );

  if (!conversation) {
    return res.status(404).json({
      success: false,
      message: 'Conversation not found'
    });
  }

  const normalizedType =
    String(userType || '').toUpperCase();

  const validParticipant =
    isConversationParticipant(conversation, normalizedType, userId);

  if (!validParticipant) {
    return res.status(403).json({
      success: false,
      message: 'You are not a participant in this conversation'
    });
  }

  db.messages.forEach(message => {
    if (
      String(message.conversation_id) ===
        String(conversation.id) &&
      message.sender_type !== normalizedType
    ) {
      message.read = true;
      message.read_at = new Date().toISOString();
    }
  });

  writeDatabase(db);

  res.json({
    success: true,
    message: 'Messages marked as read'
  });
});

function isConversationParticipant(conversation, userType, userId) {
  const normalizedType = String(userType || '').toUpperCase();

  return (
    (normalizedType === 'CUSTOMER' &&
      String(conversation.customer_id) === String(userId)) ||
    (normalizedType === 'PROVIDER' &&
      String(conversation.provider_id) === String(userId))
  );
}

module.exports = router;
