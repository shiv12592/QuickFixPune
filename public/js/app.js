(() => {
  const customerIdKey = 'quickfix.customerId';
  const customerNameKey = 'quickfix.customerName';
  const providerIdKey = 'quickfix.providerId';

  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
      }
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'The request could not be completed.');
    }

    return data;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    })[character]);
  }

  function getCustomer() {
    return {
      id: localStorage.getItem(customerIdKey),
      name: localStorage.getItem(customerNameKey)
    };
  }

  function setCustomer(customer) {
    localStorage.setItem(customerIdKey, String(customer.id));
    localStorage.setItem(customerNameKey, String(customer.name));
  }

  function getProviderId() {
    return localStorage.getItem(providerIdKey);
  }

  function setProviderId(providerId) {
    localStorage.setItem(providerIdKey, String(providerId));
  }

  window.QF = {
    api,
    escapeHtml,
    getCustomer,
    setCustomer,
    getProviderId,
    setProviderId
  };

  document.querySelectorAll('.menu-toggle').forEach(button => {
    button.addEventListener('click', () => {
      const menu = document.getElementById(button.getAttribute('aria-controls'));
      const expanded = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!expanded));
      button.setAttribute('aria-label', expanded ? 'Open navigation' : 'Close navigation');
      menu.hidden = expanded;
    });
  });

  const placeholderTitle = document.getElementById('placeholder-title');
  if (placeholderTitle && document.body.dataset.page === 'placeholder') {
    const pageName = new URLSearchParams(window.location.search).get('page');
    if (pageName) {
      placeholderTitle.textContent = pageName;
      document.title = `${pageName} | QuickFix Pune`;
    }
  }

  document.querySelectorAll('[data-logout-provider]').forEach(button => {
    button.addEventListener('click', () => {
      localStorage.removeItem(providerIdKey);
      window.location.assign('/provider');
    });
  });
})();