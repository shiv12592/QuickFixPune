(() => {
  const { api, escapeHtml, getProviderId, setProviderId } = window.QF;
  const dashboard = document.getElementById('provider-dashboard-content');
  const requestsList = document.getElementById('provider-requests');
  const identityForm = document.getElementById('provider-identity-form');
  const identityInput = document.getElementById('provider-id');

  if (!dashboard && !requestsList) return;

  const initialProviderId = getProviderId() || '1';
  if (identityInput) identityInput.value = initialProviderId;

  if (identityForm && identityInput) {
    identityForm.addEventListener('submit', event => {
      event.preventDefault();
      const providerId = identityInput.value.trim();
      if (!providerId) return;
      setProviderId(providerId);
      loadProvider();
    });
  }

  if (dashboard) {
    dashboard.addEventListener('click', event => {
      const link = event.target.closest('[data-conversation-id]');
      if (link) openChat(link.dataset.conversationId);
    });
    document.getElementById('availability-select').addEventListener('change', updateAvailability);
  }

  if (requestsList) {
    requestsList.addEventListener('click', event => {
      const button = event.target.closest('[data-conversation-id]');
      if (button) openChat(button.dataset.conversationId);
    });
  }

  loadProvider();

  async function loadProvider() {
    const providerId = getProviderId() || identityInput?.value.trim() || '1';
    if (!providerId) {
      showError('Enter a provider ID to load your workspace.');
      return;
    }
    if (identityInput) identityInput.value = providerId;
    setProviderId(providerId);
    clearError();

    try {
      const [{ provider }, { conversations }] = await Promise.all([
        api(`/api/providers/${encodeURIComponent(providerId)}/dashboard`),
        api(`/api/messages/conversations/provider/${encodeURIComponent(providerId)}`)
      ]);

      if (dashboard) renderDashboard(provider, conversations);
      if (requestsList) renderRequests(conversations);
    } catch (error) {
      showError(error.message);
      const loading = document.getElementById('provider-loading');
      if (loading) loading.hidden = true;
      if (dashboard) dashboard.hidden = true;
      if (requestsList) {
        requestsList.innerHTML = `<div class="empty-state"><h3>Unable to load requests</h3><p>${escapeHtml(error.message)}</p><button class="button button-secondary" type="button" data-retry-requests>Try again</button></div>`;
        requestsList.querySelector('[data-retry-requests]').addEventListener('click', loadProvider);
      }
    }
  }

  function renderDashboard(provider, conversations) {
    document.getElementById('provider-loading').hidden = true;
    dashboard.hidden = false;
    document.getElementById('provider-greeting').textContent = `, ${provider.name}.`;
    document.getElementById('provider-area').textContent =
      `${provider.service} · ${provider.area}, ${provider.pincode}`;
    document.getElementById('provider-name').textContent = provider.name;
    document.getElementById('provider-avatar').textContent =
      String(provider.name || 'Q').trim().charAt(0).toUpperCase();
    document.getElementById('provider-summary').textContent =
      `${provider.service} · ${provider.experience} years' experience · ${provider.area}`;
    const verification = document.getElementById('verification-badge');
    verification.textContent = provider.verification_status || 'STATUS NOT SET';
    verification.classList.toggle('verified', provider.verification_status === 'VERIFIED');

    const availability = document.getElementById('availability-select');
    availability.value = provider.availability || 'AVAILABLE';
    availability.dataset.previousValue = availability.value;
    document.getElementById('new-request-count').textContent =
      conversations.filter(item => item.request_status === 'PENDING').length;
    document.getElementById('unread-count').textContent =
      conversations.reduce((sum, item) => sum + Number(item.unread_count || 0), 0);
    document.getElementById('active-count').textContent =
      conversations.filter(item => item.status !== 'CLOSED').length;

    const recent = document.getElementById('recent-conversations');
    const latest = conversations
      .slice()
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
      .slice(0, 5);
    if (!latest.length) {
      recent.innerHTML = '<div class="empty-state"><h3>No requests yet</h3><p>New customer requests will show up here.</p></div>';
      return;
    }
    recent.innerHTML = latest.map(conversationCard).join('');
  }

  function renderRequests(conversations) {
    const latest = conversations
      .slice()
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    if (!latest.length) {
      requestsList.innerHTML = '<div class="empty-state"><h3>No customer requests yet</h3><p>When a customer starts a chat, their request will appear here.</p><a href="/provider" class="button button-secondary">Back to dashboard</a></div>';
      return;
    }
    requestsList.innerHTML = latest.map(conversationCard).join('');
  }

  function conversationCard(conversation) {
    const lastCustomerMessage = (conversation.messages || [])
      .filter(message => message.sender_type === 'CUSTOMER')
      .at(-1);
    const requestDescription = conversation.request_description ||
      lastCustomerMessage?.message || 'Customer started a conversation.';
    const unread = Number(conversation.unread_count || 0);
    return `<article class="conversation-card">
      <div class="conversation-top"><h3>${escapeHtml(conversation.customer?.name || 'Customer')}</h3>${unread ? `<span class="unread-count" aria-label="${unread} unread messages">${unread}</span>` : ''}</div>
      <p class="muted">${escapeHtml(conversation.service)} · ${escapeHtml(conversation.reference || `Conversation ${conversation.id}`)}</p>
      <p class="conversation-preview">${escapeHtml(requestDescription)}</p>
      ${conversation.preferred_visit_time ? `<p class="muted">Preferred time: ${escapeHtml(conversation.preferred_visit_time)}</p>` : ''}
      <div class="conversation-meta"><span class="request-status">${escapeHtml(conversation.request_status || conversation.status)}</span><time>${formatDate(conversation.created_at)}</time></div>
      <button type="button" class="button button-secondary" data-conversation-id="${escapeHtml(conversation.id)}">Open chat <span aria-hidden="true">→</span></button>
    </article>`;
  }

  async function updateAvailability(event) {
    const select = event.currentTarget;
    const providerId = getProviderId();
    select.disabled = true;
    try {
      const { provider } = await api(
        `/api/providers/${encodeURIComponent(providerId)}/availability`,
        {
          method: 'PATCH',
          body: JSON.stringify({ availability: select.value })
        }
      );
      select.value = provider.availability;
      const feedback = document.getElementById('provider-feedback');
      feedback.textContent = `Availability updated to ${provider.availability.toLowerCase()}.`;
      feedback.hidden = false;
      window.setTimeout(() => { feedback.hidden = true; }, 3500);
    } catch (error) {
      showError(error.message);
      select.value = select.dataset.previousValue || 'AVAILABLE';
    } finally {
      select.disabled = false;
      select.dataset.previousValue = select.value;
    }
  }

  function openChat(conversationId) {
    window.location.assign(
      `/provider-chat.html?conversationId=${encodeURIComponent(conversationId)}`
    );
  }

  function showError(message) {
    const element = document.getElementById('provider-error');
    element.textContent = message;
    element.hidden = false;
  }

  function clearError() {
    const element = document.getElementById('provider-error');
    element.textContent = '';
    element.hidden = true;
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }
})();
