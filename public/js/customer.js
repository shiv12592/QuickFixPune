(() => {
  const { api, escapeHtml, getCustomer, setCustomer } = window.QF;

  const searchForm = document.getElementById('provider-search');
  if (searchForm) {
    searchForm.addEventListener('submit', searchProviders);
    [searchForm.elements.area, searchForm.elements.pincode].forEach(input => {
      input.addEventListener('input', () => {
        document.getElementById('search-feedback').textContent = '';
      });
    });
    document.querySelectorAll('[data-service]').forEach(button => {
      button.addEventListener('click', () => {
        searchForm.elements.service.value = button.dataset.service;
        searchForm.elements.area.focus();
      });
    });
    document.getElementById('results').addEventListener('click', event => {
      const button = event.target.closest('[data-provider-id]');
      if (button) {
        window.location.assign(
          `/customer-details.html?providerId=${encodeURIComponent(button.dataset.providerId)}`
        );
      }
    });
  }

  async function searchProviders(event) {
    event.preventDefault();
    const formData = new FormData(searchForm);
    const service = String(formData.get('service') || '').trim();
    const area = String(formData.get('area') || '').trim();
    const pincode = String(formData.get('pincode') || '').trim();
    const results = document.getElementById('results');
    const title = document.getElementById('results-title');

    if (!service) {
      searchForm.elements.service.focus();
      return;
    }

    if (!area && !pincode) {
      document.getElementById('search-feedback').textContent =
        'Enter an area or a 6-digit pincode to continue.';
      searchForm.elements.area.focus();
      return;
    }

    if (pincode && !/^\d{6}$/.test(pincode)) {
      searchForm.elements.pincode.setCustomValidity('Enter a valid 6-digit pincode.');
      searchForm.elements.pincode.reportValidity();
      searchForm.elements.pincode.addEventListener('input', () => {
        searchForm.elements.pincode.setCustomValidity('');
      }, { once: true });
      return;
    }

    const params = new URLSearchParams({ service });
    if (area) params.set('area', area);
    if (pincode) params.set('pincode', pincode);
    title.textContent = `Verified ${service.toLowerCase()}s`;
    results.innerHTML = '<div class="loading-state">Finding verified providers near you…</div>';

    try {
      const { providers } = await api(`/api/providers?${params}`);
      if (!providers.length) {
        results.innerHTML = `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌕</span><h3>No verified providers found</h3><p>Try a nearby area or another service. We’ll keep looking for local professionals.</p></div>`;
        return;
      }

      results.innerHTML = providers.map(provider => {
        const availability = String(provider.availability || 'AVAILABLE').toUpperCase();
        const availabilityLabel = availability.charAt(0) + availability.slice(1).toLowerCase();
        return `<article class="provider-card">
          <div class="conversation-top"><h3>${escapeHtml(provider.name)}</h3><span class="verified-badge">Verified</span></div>
          <p class="provider-service">${escapeHtml(provider.service)}</p>
          <div class="provider-details">
            <span>${escapeHtml(provider.experience)} years' experience</span>
            <span>${escapeHtml(provider.area)}</span>
            <span>${escapeHtml(provider.pincode)}</span>
            <span class="availability-badge ${availability.toLowerCase()}">${escapeHtml(availabilityLabel)}</span>
          </div>
          <button class="button button-primary" type="button" data-provider-id="${escapeHtml(provider.id)}">View profile &amp; start chat <span aria-hidden="true">→</span></button>
        </article>`;
      }).join('');
    } catch (error) {
      results.innerHTML = `<div class="empty-state"><h3>We couldn’t search right now</h3><p>${escapeHtml(error.message)}</p><button class="button button-secondary" type="button" data-retry-search>Try again</button></div>`;
      results.querySelector('[data-retry-search]').addEventListener('click', () => searchForm.requestSubmit());
    }
  }

  const requestForm = document.getElementById('request-form');
  if (requestForm) {
    loadProviderForRequest();
    const customer = getCustomer();
    const customerFields = document.getElementById('customer-details-fields');
    customerFields.hidden = Boolean(customer.id);
    customerFields.querySelectorAll('input').forEach(input => {
      input.required = !customer.id;
    });

    requestForm.addEventListener('submit', startConversation);
  }

  async function loadProviderForRequest() {
    const providerId = new URLSearchParams(window.location.search).get('providerId');
    const summary = document.getElementById('provider-summary');
    const submitButton = requestForm.querySelector('[type="submit"]');
    submitButton.disabled = true;

    if (!providerId) {
      summary.innerHTML = '<h2>Provider not selected</h2><p class="muted">Return to search and choose a provider to send a request.</p>';
      return;
    }

    try {
      const { provider } = await api(`/api/providers/${encodeURIComponent(providerId)}`);
      summary.innerHTML = `<div class="conversation-top"><h2>${escapeHtml(provider.name)}</h2><span class="verified-badge">Verified</span></div>
        <p class="muted">${escapeHtml(provider.service)}</p>
        <div class="summary-meta"><span>${escapeHtml(provider.experience)} years' experience</span><span>${escapeHtml(provider.area)}</span><span class="availability-badge ${escapeHtml(String(provider.availability).toLowerCase())}">${escapeHtml(provider.availability)}</span></div>`;
      requestForm.dataset.providerId = provider.id;
      requestForm.dataset.service = provider.service;
      submitButton.disabled = false;
    } catch (error) {
      summary.innerHTML = `<h2>Unable to load provider</h2><p class="muted">${escapeHtml(error.message)}</p>`;
    }
  }

  async function startConversation(event) {
    event.preventDefault();
    const customerFields = document.getElementById('customer-details-fields');
    let customer = getCustomer();
    if (!customer.id) {
      const name = requestForm.elements.customerName.value.trim();
      const mobile = requestForm.elements.customerMobile.value.replace(/\D/g, '');
      if (!name || !/^[6-9]\d{9}$/.test(mobile)) {
        requestForm.elements.customerMobile.setCustomValidity('Enter a valid 10-digit Indian mobile number.');
        requestForm.elements.customerMobile.reportValidity();
        requestForm.elements.customerMobile.addEventListener('input', () => {
          requestForm.elements.customerMobile.setCustomValidity('');
        }, { once: true });
        return;
      }

      try {
        const result = await api('/api/customers/register', {
          method: 'POST',
          body: JSON.stringify({ name, mobile })
        });
        customer = result.customer;
        setCustomer(customer);
        customerFields.hidden = true;
        customerFields.querySelectorAll('input').forEach(input => {
          input.required = false;
        });
      } catch (error) {
        showFeedback(error.message, true);
        return;
      }
    }

    const button = document.getElementById('send-request');
    button.disabled = true;
    button.textContent = 'Sending request…';
    try {
      const result = await api('/api/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({
          customerId: customer.id,
          providerId: requestForm.dataset.providerId,
          service: requestForm.dataset.service,
          initialMessage: requestForm.elements.problem.value.trim(),
          preferredVisitTime: requestForm.elements.visitTime.value.trim()
        })
      });
      window.location.assign(`/customer-chat.html?conversationId=${encodeURIComponent(result.conversation.id)}`);
    } catch (error) {
      showFeedback(error.message, true);
      button.disabled = false;
      button.innerHTML = 'Send request &amp; start chat <span aria-hidden="true">→</span>';
    }
  }

  function showFeedback(message, isError) {
    const feedback = document.getElementById('request-feedback');
    feedback.textContent = message;
    feedback.classList.toggle('feedback-error', isError);
    feedback.hidden = false;
  }

  const chatList = document.getElementById('chat-list');
  if (chatList) loadCustomerChats(chatList);

  async function loadCustomerChats(container) {
    const customer = getCustomer();
    if (!customer.id) {
      container.innerHTML = '<div class="empty-state"><h3>No chats yet</h3><p>Find a verified provider and send your first service request.</p><a class="button button-primary" href="/customer">Find a provider</a></div>';
      return;
    }

    try {
      const { conversations } = await api(
        `/api/messages/conversations/customer/${encodeURIComponent(customer.id)}`
      );
      if (!conversations.length) {
        container.innerHTML = '<div class="empty-state"><h3>No conversations yet</h3><p>Your chats with local providers will appear here.</p><a class="button button-primary" href="/customer">Find a provider</a></div>';
        return;
      }

      container.innerHTML = conversations
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
        .map(conversation => {
          const lastMessage = conversation.messages.at(-1);
          const unread = Number(conversation.unread_count || 0);
          return `<article class="conversation-card">
            <div class="conversation-top"><h3>${escapeHtml(conversation.provider?.name || 'QuickFix provider')}</h3>${unread ? `<span class="unread-count" aria-label="${unread} unread messages">${unread}</span>` : ''}</div>
            <p class="muted">${escapeHtml(conversation.service)} · ${escapeHtml(conversation.provider?.area || '')}</p>
            <p class="conversation-preview">${escapeHtml(lastMessage?.message || conversation.request_description || 'Start the conversation')}</p>
            <div class="conversation-meta"><span>${escapeHtml(conversation.request_status || conversation.status)}</span><span>${escapeHtml(conversation.provider?.availability || 'AVAILABLE')}</span><time>${formatDate(conversation.updated_at)}</time></div>
            <a class="button button-secondary" href="/customer-chat.html?conversationId=${encodeURIComponent(conversation.id)}">Open chat <span aria-hidden="true">→</span></a>
          </article>`;
        }).join('');
    } catch (error) {
      container.innerHTML = `<div class="empty-state"><h3>Unable to load chats</h3><p>${escapeHtml(error.message)}</p><button class="button button-secondary" type="button" data-retry-chats>Try again</button></div>`;
      container.querySelector('[data-retry-chats]').addEventListener('click', () => loadCustomerChats(container));
    }
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }
})();
