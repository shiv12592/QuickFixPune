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
    initialMessage
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
      service: String(service || provider.service).trim(),
      status: 'OPEN',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    db.conversations.push(conversation);
  }

  if (initialMessage && String(initialMessage).trim()) {
    const message = {
      id: generateId(),
      conversation_id: conversation.id,
      sender_type: 'CUSTOMER',
      sender_id: customer.id,
      message: String(initialMessage).trim(),
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
              area: provider.area
            }
          : null,
        messages
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
        messages
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
    conversation,
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

  const isCustomer =
    normalizedSenderType === 'CUSTOMER' &&
    String(conversation.customer_id) === String(senderId);

  const isProvider =
    normalizedSenderType === 'PROVIDER' &&
    String(conversation.provider_id) === String(senderId);

  if (!isCustomer && !isProvider) {
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
    (
      normalizedType === 'CUSTOMER' &&
      String(conversation.customer_id) === String(userId)
    ) ||
    (
      normalizedType === 'PROVIDER' &&
      String(conversation.provider_id) === String(userId)
    );

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

module.exports = router;
