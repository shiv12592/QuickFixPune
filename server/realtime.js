const { readDatabase, writeDatabase } = require('./database');

function generateId() {
  return Date.now() + Math.floor(Math.random() * 10000);
}

function createMessage(conversationId, senderType, senderId, message) {
  const db = readDatabase();

  const conversation = db.conversations.find(
    item =>
      String(item.id) === String(conversationId) &&
      item.status !== 'CLOSED'
  );

  if (!conversation) {
    throw new Error('Conversation not found or closed');
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
    throw new Error('You are not a participant in this conversation');
  }

  const cleanMessage = String(message || '').trim();

  if (!cleanMessage) {
    throw new Error('Message cannot be empty');
  }

  if (cleanMessage.length > 1000) {
    throw new Error('Message cannot exceed 1000 characters');
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

  return newMessage;
}

function isParticipant(conversationId, userType, userId) {
  const db = readDatabase();

  const conversation = db.conversations.find(
    item => String(item.id) === String(conversationId)
  );

  if (!conversation) {
    return false;
  }

  const normalizedType =
    String(userType || '').toUpperCase();

  return (
    (
      normalizedType === 'CUSTOMER' &&
      String(conversation.customer_id) === String(userId)
    ) ||
    (
      normalizedType === 'PROVIDER' &&
      String(conversation.provider_id) === String(userId)
    )
  );
}

function setupRealtime(io) {
  io.on('connection', socket => {
    console.log(`[Socket] Connected: ${socket.id}`);

    socket.on('join_conversation', data => {
      try {
        const {
          conversationId,
          userType,
          userId
        } = data || {};

        if (
          !conversationId ||
          !userType ||
          !userId
        ) {
          socket.emit('message_error', {
            message: 'Conversation and user details are required'
          });
          return;
        }

        if (
          !isParticipant(
            conversationId,
            userType,
            userId
          )
        ) {
          socket.emit('message_error', {
            message: 'You are not a participant in this conversation'
          });
          return;
        }

        const room = `conversation:${conversationId}`;

        socket.join(room);

        socket.data.conversationId = String(conversationId);
        socket.data.userType =
          String(userType).toUpperCase();
        socket.data.userId = String(userId);

        socket.emit('conversation_joined', {
          conversationId
        });

        console.log(
          `[Socket] ${socket.id} joined ${room}`
        );
      } catch (error) {
        console.error('[Socket] Join error:', error);

        socket.emit('message_error', {
          message: 'Unable to join conversation'
        });
      }
    });

    socket.on('send_message', data => {
      try {
        const {
          conversationId,
          message
        } = data || {};

        const userType = socket.data.userType;
        const userId = socket.data.userId;

        if (
          String(conversationId) !==
          String(socket.data.conversationId)
        ) {
          socket.emit('message_error', {
            message: 'Join the conversation first'
          });
          return;
        }

        const newMessage = createMessage(
          conversationId,
          userType,
          userId,
          message
        );

        const room =
          `conversation:${conversationId}`;

        io.to(room).emit(
          'new_message',
          newMessage
        );

        console.log(
          `[Socket] Message sent to ${room}`
        );
      } catch (error) {
        console.error('[Socket] Message error:', error);

        socket.emit('message_error', {
          message: error.message
        });
      }
    });

    socket.on('typing_start', data => {
      const conversationId =
        socket.data.conversationId;

      if (!conversationId) {
        return;
      }

      socket.to(
        `conversation:${conversationId}`
      ).emit('user_typing', {
        userType: socket.data.userType,
        userId: socket.data.userId
      });
    });

    socket.on('typing_stop', data => {
      const conversationId =
        socket.data.conversationId;

      if (!conversationId) {
        return;
      }

      socket.to(
        `conversation:${conversationId}`
      ).emit('user_stopped_typing', {
        userType: socket.data.userType,
        userId: socket.data.userId
      });
    });

    socket.on('disconnect', () => {
      console.log(`[Socket] Disconnected: ${socket.id}`);
    });
  });
}

module.exports = {
  setupRealtime
};
