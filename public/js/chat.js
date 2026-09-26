(async () => {
  await window.QF.ready;
  const { api, getCustomer, getProviderId } = window.QF;
  const userType = document.body.dataset.userType;
  const identity = window.QF.authenticationEnabled
    ? await window.QF.requireRole(userType)
    : null;
  if (window.QF.authenticationEnabled && !identity) return;
  const user = identity || (
    userType === 'CUSTOMER' ? getCustomer() : { id: getProviderId() }
  );
  const conversationId = new URLSearchParams(window.location.search).get('conversationId');
  const list = document.getElementById('messages');
  const input = document.getElementById('message-input');
  const form = document.getElementById('message-form');
  const error = document.getElementById('chat-error');
  const typingIndicator = document.getElementById('typing-indicator');
  const renderedMessageIds = new Set();
  let socket;
  let typingTimeout;
  let typingStoppedTimeout;
  let lastTypingState = false;
  let sending = false;
  let pendingMessageText = '';

  if (!conversationId || !user.id) {
    showError(!conversationId
      ? 'This chat link is missing a conversation ID.'
      : 'Your local identity is missing. Return to the marketplace or provider dashboard and try again.');
    list.innerHTML = '';
    form.hidden = true;
    return;
  }

  if (typeof window.io === 'function') {
    socket = window.io();
    socket.on('connect', () => {
      socket.emit('join_conversation', window.QF.authenticationEnabled
        ? { conversationId }
        : { conversationId, userType, userId: user.id });
    });
    socket.on('connect_error', error => {
      if (window.QF.authenticationEnabled && /auth/i.test(error.message)) {
        const params = new URLSearchParams({
          role: userType.toLowerCase(),
          next: `${window.location.pathname}${window.location.search}`
        });
        window.location.assign(`/login?${params}`);
        return;
      }
      showError('Live chat is reconnecting. Check that the QuickFix server is running.');
    });
    socket.on('conversation_joined', () => clearError());
    socket.on('new_message', message => {
      if (String(message.conversation_id) !== String(conversationId)) return;
      renderMessage(message);
      if (message.sender_type !== userType) markConversationRead();
      typingIndicator.hidden = true;
    });
    socket.on('message_error', data => {
      if (!input.value.trim() && pendingMessageText) input.value = pendingMessageText;
      pendingMessageText = '';
      sending = false;
      showError(data.message || 'Unable to send this message.');
    });
    socket.on('user_typing', data => {
      if (data.userType !== userType) {
        typingIndicator.hidden = false;
        window.clearTimeout(typingStoppedTimeout);
        typingStoppedTimeout = window.setTimeout(() => { typingIndicator.hidden = true; }, 2200);
      }
    });
    socket.on('user_stopped_typing', data => {
      if (data.userType !== userType) typingIndicator.hidden = true;
    });
    socket.on('disconnect', () => {
      showError('Live chat disconnected. Reconnecting…');
    });
  } else {
    showError('Live chat is unavailable because the Socket.IO client did not load.');
  }

  form.addEventListener('submit', sendMessage);
  input.addEventListener('input', handleTyping);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  loadConversation();

  async function loadConversation() {
    try {
      const endpoint = `/api/messages/conversations/${encodeURIComponent(conversationId)}/messages`;
      const suffix = window.QF.authenticationEnabled
        ? ''
        : `?${new URLSearchParams({ userType, userId: String(user.id) })}`;
      const data = await api(`${endpoint}${suffix}`);
      const conversation = data.conversation;
      document.getElementById('chat-title').textContent =
        userType === 'CUSTOMER'
          ? conversation.provider?.name || 'Provider'
          : conversation.customer?.name || 'Customer';
      document.getElementById('chat-subtitle').textContent =
        `${conversation.service || ''}${conversation.reference ? ` · ${conversation.reference}` : ''}`;
      const status = document.getElementById('chat-status');
      if (userType === 'CUSTOMER' && conversation.provider?.availability) {
        status.textContent = conversation.provider.availability;
        status.classList.add(conversation.provider.availability.toLowerCase());
        status.hidden = false;
      }

      list.querySelector('.loading-state')?.remove();
      data.messages.forEach(renderMessage);
      if (!list.querySelector('.message')) {
        const empty = document.createElement('li');
        empty.className = 'empty-state';
        empty.textContent = 'No messages yet. Send a message to get the conversation started.';
        list.append(empty);
      }
      await markConversationRead();
    } catch (loadError) {
      list.replaceChildren();
      showError(loadError.message);
      form.hidden = true;
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) {
      input.focus();
      return;
    }
    if (message.length > 1000) {
      showError('Messages can’t exceed 1000 characters.');
      return;
    }
    if (sending) return;
    if (!socket || !socket.connected) {
      showError('Live chat is reconnecting. Your message has not been sent yet.');
      return;
    }

    sending = true;
    pendingMessageText = message;
    socket.emit('send_message', window.QF.authenticationEnabled
      ? { conversationId, message }
      : {
        conversationId,
        message,
        senderType: userType,
        senderId: user.id
      });
    input.value = '';
    input.style.height = '';
    stopTyping();
    window.setTimeout(() => { sending = false; }, 1500);
    input.focus();
  }

  function renderMessage(message) {
    if (renderedMessageIds.has(String(message.id))) return;
    renderedMessageIds.add(String(message.id));
    if (message.sender_type === userType) {
      pendingMessageText = '';
      sending = false;
    }
    const emptyState = list.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const item = document.createElement('li');
    item.className = `message${message.sender_type === userType ? ' mine' : ''}`;
    const date = new Date(message.created_at);
    item.dataset.createdAt = String(date.getTime());
    const content = document.createElement('p');
    content.textContent = message.message;
    const timestamp = document.createElement('time');
    timestamp.dateTime = date.toISOString();
    timestamp.textContent = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    item.append(content, timestamp);
    list.querySelector('.loading-state')?.remove();
    const nextMessage = Array.from(list.querySelectorAll('.message'))
      .find(existing => Number(existing.dataset.createdAt) > date.getTime());
    list.insertBefore(item, nextMessage || null);
    list.scrollTop = list.scrollHeight;
  }

  function handleTyping() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
    if (!input.value.trim()) {
      stopTyping();
      return;
    }
    if (socket?.connected && !lastTypingState) {
      socket.emit('typing_start', { conversationId });
      lastTypingState = true;
    }
    window.clearTimeout(typingTimeout);
    typingTimeout = window.setTimeout(stopTyping, 900);
  }

  function stopTyping() {
    window.clearTimeout(typingTimeout);
    if (socket?.connected && lastTypingState) {
      socket.emit('typing_stop', { conversationId });
    }
    lastTypingState = false;
  }

  async function markConversationRead() {
    try {
      await api(`/api/messages/conversations/${encodeURIComponent(conversationId)}/read`, {
        method: 'POST',
        body: JSON.stringify(window.QF.authenticationEnabled
          ? {}
          : { userType, userId: user.id })
      });
    } catch (readError) {
      showError(readError.message);
    }
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  function clearError() {
    error.textContent = '';
    error.hidden = true;
  }
})().catch(error => {
  console.error('[UI] Chat could not initialize:', error.message);
  const errorElement = document.getElementById('chat-error');
  if (errorElement) {
    errorElement.textContent = 'QuickFix could not verify this session. Please sign in again.';
    errorElement.hidden = false;
  }
});
