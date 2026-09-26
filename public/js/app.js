(() => {
  const customerIdKey = 'quickfix.customerId';
  const customerNameKey = 'quickfix.customerName';
  const providerIdKey = 'quickfix.providerId';
  let authenticatedIdentity = null;
  let authRequired = false;

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'include',
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
      }
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.message || 'The request could not be completed.');
      error.status = response.status;
      error.code = data.code;
      error.retryAfter = response.headers.get('retry-after');
      throw error;
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
    if (authRequired) {
      return authenticatedIdentity?.role === 'CUSTOMER'
        ? { id: authenticatedIdentity.id, name: authenticatedIdentity.name }
        : { id: null, name: null };
    }
    return {
      id: localStorage.getItem(customerIdKey),
      name: localStorage.getItem(customerNameKey)
    };
  }

  function setCustomer(customer) {
    if (authRequired) return;
    localStorage.setItem(customerIdKey, String(customer.id));
    localStorage.setItem(customerNameKey, String(customer.name));
  }

  function getProviderId() {
    return authRequired
      ? authenticatedIdentity?.role === 'PROVIDER' ? authenticatedIdentity.id : null
      : localStorage.getItem(providerIdKey);
  }

  function setProviderId(providerId) {
    if (!authRequired) localStorage.setItem(providerIdKey, String(providerId));
  }

  function loginUrl(role) {
    const currentPath = `${window.location.pathname}${window.location.search}`;
    const params = new URLSearchParams({
      role: role.toLowerCase(),
      next: currentPath
    });
    return `/login?${params}`;
  }

  async function requireRole(role) {
    if (!authRequired) return null;
    if (!authenticatedIdentity) {
      try {
        const result = await api('/api/auth/me');
        authenticatedIdentity = result.user;
      } catch (error) {
        if (error.status !== 401) throw error;
      }
    }
    if (!authenticatedIdentity || authenticatedIdentity.role !== role) {
      window.location.assign(loginUrl(role));
      return null;
    }
    return authenticatedIdentity;
  }

  const QF = {
    api,
    escapeHtml,
    getCustomer,
    setCustomer,
    getProviderId,
    setProviderId,
    requireRole,
    identity: null,
    authenticationEnabled: false,
    ready: null
  };
  window.QF = QF;

  QF.ready = api('/api/auth/status').then(async status => {
    authRequired = Boolean(status.authenticationEnabled);
    QF.authenticationEnabled = authRequired;
    if (authRequired) {
      localStorage.removeItem(customerIdKey);
      localStorage.removeItem(customerNameKey);
      localStorage.removeItem(providerIdKey);
      const role = document.body.dataset.authRole;
      if (role) {
        authenticatedIdentity = await requireRole(role.toUpperCase());
        QF.identity = authenticatedIdentity;
      }
    }
  });

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

  document.querySelectorAll('[data-logout-provider], [data-logout]').forEach(button => {
    button.addEventListener('click', async () => {
      try {
        if (QF.authenticationEnabled) {
          await api('/api/auth/logout', { method: 'POST' });
        } else {
          localStorage.removeItem(providerIdKey);
          localStorage.removeItem(customerIdKey);
          localStorage.removeItem(customerNameKey);
        }
        window.location.assign(QF.authenticationEnabled
          ? '/login'
          : button.hasAttribute('data-logout-provider') ? '/provider' : '/customer');
      } catch (error) {
        button.textContent = error.message;
      }
    });
  });
})();
