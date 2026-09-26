const {
  findConversation,
  persistSocketMessage
} = require('./routes/postgres/messages');
const { pool } = require('./db/pool');
const { readCookie, findActiveSession } = require('./middleware/auth');

async function socketSessionIsActive(session) {
  const result = await pool.query(
    `SELECT s.id
     FROM auth_sessions s
     LEFT JOIN provider_profiles pp ON pp.user_id = s.user_id
     WHERE s.id = $1 AND s.user_id = $2
       AND s.revoked_at IS NULL AND s.expires_at > now()
       AND (s.role = 'CUSTOMER' OR pp.verification_status = 'VERIFIED')`,
    [session.sessionId, session.userId]
  );
  return result.rowCount > 0;
}

function setupRealtimePostgres(io) {
  io.use(async (socket, next) => {
    try {
      const token = readCookie(socket.request.headers.cookie, 'qf_session');
      const session = await findActiveSession(pool, token);
      if (
        !session ||
        (session.role === 'PROVIDER' && session.verificationStatus !== 'VERIFIED')
      ) {
        return next(new Error('Authentication required'));
      }
      socket.data.auth = session;
      return next();
    } catch (error) {
      console.error('[Socket] Authentication lookup failed');
      return next(new Error('Unable to authenticate connection'));
    }
  });

  io.on('connection', socket => {
    socket.join(`session:${socket.data.auth.sessionId}`);

    socket.on('join_conversation', async data => {
      try {
        if (!(await socketSessionIsActive(socket.data.auth))) {
          socket.disconnect(true);
          return;
        }
        const conversationId = String(data?.conversationId || '');
        if (!conversationId) {
          socket.emit('message_error', {
            message: 'Conversation is required'
          });
          return;
        }
        const conversation = await findConversation(pool, conversationId);
        if (
          !conversation ||
          (socket.data.auth.role === 'CUSTOMER' &&
            socket.data.auth.userId !== conversation.customer_id) ||
          (socket.data.auth.role === 'PROVIDER' &&
            socket.data.auth.userId !== conversation.provider_id)
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
        socket.join(`conversation:${conversationId}`);
        socket.emit('conversation_joined', { conversationId });
      } catch (error) {
        console.error('[Socket] Join failed');
        socket.emit('message_error', { message: 'Unable to join conversation' });
      }
    });

    socket.on('send_message', async data => {
      try {
        if (!(await socketSessionIsActive(socket.data.auth))) {
          socket.disconnect(true);
          return;
        }
        const conversationId = String(data?.conversationId || '');
        if (!socket.data.conversationId || conversationId !== socket.data.conversationId) {
          socket.emit('message_error', { message: 'Join the conversation first' });
          return;
        }
        const message = await persistSocketMessage(
          conversationId,
          socket.data.auth.role,
          socket.data.auth.publicId,
          data?.message
        );
        io.to(`conversation:${conversationId}`).emit('new_message', message);
      } catch (error) {
        console.error('[Socket] Message persistence failed');
        const clientMessages = new Set([
          'Message cannot be empty',
          'Message cannot exceed 1000 characters',
          'Conversation not found or closed',
          'You are not a participant in this conversation'
        ]);
        socket.emit('message_error', {
          message: clientMessages.has(error.message)
            ? error.message
            : 'Unable to send this message'
        });
      }
    });

    socket.on('typing_start', async () => {
      try {
        if (!(await socketSessionIsActive(socket.data.auth))) {
          socket.disconnect(true);
          return;
        }
        const conversationId = socket.data.conversationId;
        if (!conversationId) return;
        socket.to(`conversation:${conversationId}`).emit('user_typing', {
          userType: socket.data.auth.role
        });
      } catch {
        console.error('[Socket] Session revalidation failed');
        socket.disconnect(true);
      }
    });

    socket.on('typing_stop', async () => {
      try {
        if (!(await socketSessionIsActive(socket.data.auth))) {
          socket.disconnect(true);
          return;
        }
        const conversationId = socket.data.conversationId;
        if (!conversationId) return;
        socket.to(`conversation:${conversationId}`).emit('user_stopped_typing', {
          userType: socket.data.auth.role
        });
      } catch {
        console.error('[Socket] Session revalidation failed');
        socket.disconnect(true);
      }
    });

    const expiresIn = new Date(socket.data.auth.expiresAt).getTime() - Date.now();
    const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, expiresIn));
    expiryTimer.unref();
    const sessionTimer = setInterval(async () => {
      try {
        if (!(await socketSessionIsActive(socket.data.auth))) socket.disconnect(true);
      } catch {
        console.error('[Socket] Session revalidation failed');
        socket.disconnect(true);
      }
    }, 60000);
    sessionTimer.unref();
    socket.on('disconnect', () => {
      clearTimeout(expiryTimer);
      clearInterval(sessionTimer);
    });
  });
}

module.exports = { setupRealtimePostgres };
