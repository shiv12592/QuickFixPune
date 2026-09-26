const {
  findUserId,
  findConversation,
  persistSocketMessage
} = require('./routes/postgres/messages');
const { pool } = require('./db/pool');

function setupRealtimePostgres(io) {
  io.on('connection', socket => {
    console.log(`[Socket] Connected: ${socket.id}`);

    socket.on('join_conversation', async data => {
      try {
        const { conversationId, userType, userId } = data || {};
        const normalizedType = String(userType || '').toUpperCase();
        if (!conversationId || !userId || !['CUSTOMER', 'PROVIDER'].includes(normalizedType)) {
          socket.emit('message_error', {
            message: 'Conversation and user details are required'
          });
          return;
        }
        const conversation = await findConversation(pool, conversationId);
        const resolvedUserId = await findUserId(pool, normalizedType, userId);
        if (
          !conversation ||
          !resolvedUserId ||
          (normalizedType === 'CUSTOMER' && resolvedUserId !== conversation.customer_id) ||
          (normalizedType === 'PROVIDER' && resolvedUserId !== conversation.provider_id)
        ) {
          socket.emit('message_error', {
            message: 'You are not a participant in this conversation'
          });
          return;
        }
        if (socket.data.conversationId) {
          socket.leave(`conversation:${socket.data.conversationId}`);
        }
        socket.data.conversationId = conversationId;
        socket.data.userType = normalizedType;
        socket.data.userId = userId;
        socket.join(`conversation:${conversationId}`);
        socket.emit('conversation_joined', { conversationId });
      } catch (error) {
        console.error('[Socket] Join error:', error.message);
        socket.emit('message_error', { message: 'Unable to join conversation' });
      }
    });

    socket.on('send_message', async data => {
      try {
        const conversationId = String(data?.conversationId || '');
        if (!socket.data.conversationId || conversationId !== socket.data.conversationId) {
          socket.emit('message_error', { message: 'Join the conversation first' });
          return;
        }
        const message = await persistSocketMessage(
          conversationId,
          socket.data.userType,
          socket.data.userId,
          data?.message
        );
        io.to(`conversation:${conversationId}`).emit('new_message', message);
      } catch (error) {
        console.error('[Socket] Message error:', error.message);
        socket.emit('message_error', { message: error.message });
      }
    });

    socket.on('typing_start', () => {
      const conversationId = socket.data.conversationId;
      if (!conversationId) return;
      socket.to(`conversation:${conversationId}`).emit('user_typing', {
        userType: socket.data.userType,
        userId: socket.data.userId
      });
    });

    socket.on('typing_stop', () => {
      const conversationId = socket.data.conversationId;
      if (!conversationId) return;
      socket.to(`conversation:${conversationId}`).emit('user_stopped_typing', {
        userType: socket.data.userType,
        userId: socket.data.userId
      });
    });

    socket.on('disconnect', () => {
      console.log(`[Socket] Disconnected: ${socket.id}`);
    });
  });
}

module.exports = { setupRealtimePostgres };
