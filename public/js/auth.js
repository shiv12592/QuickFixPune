(async () => {
  await window.QF.ready;

  const { api, authenticationEnabled } = window.QF;
  const requestForm = document.getElementById('login-form');
  const verifyForm = document.getElementById('verify-form');
  const roleSelect = document.getElementById('account-role');
  const nameField = document.getElementById('name-field');
  const nameInput = document.getElementById('full-name');
  const mobileInput = document.getElementById('mobile');
  const otpInput = document.getElementById('otp');
  const requestButton = document.getElementById('request-otp');
  const verifyButton = document.getElementById('verify-otp');
  const resendButton = document.getElementById('resend-otp');
  const feedback = document.getElementById('login-feedback');
  const initialFeedback = document.getElementById('login-feedback-initial');
  let otpRequested = false;
  let cooldownTimer;

  const query = new URLSearchParams(window.location.search);
  const defaultRole = window.location.pathname === '/provider-login' ? 'provider' : 'customer';
  roleSelect.value = query.get('role') === 'provider' ? 'provider' :
    query.get('role') === 'customer' ? 'customer' : defaultRole;
  updateRoleFields();

  if (!authenticationEnabled) {
    showFeedback(
      initialFeedback,
      'OTP sign-in requires PostgreSQL mode. The local JSON development demo retains its legacy test identities.',
      true
    );
    requestButton.disabled = true;
    return;
  }

  try {
    const current = await api('/api/auth/me');
    const expectedRole = roleSelect.value.toUpperCase();
    if (current.user.role === expectedRole) {
      window.location.replace(getNextUrl(expectedRole));
      return;
    }
  } catch (error) {
    if (error.status !== 401) {
      showFeedback(initialFeedback, error.message, true);
      return;
    }
  }

  roleSelect.addEventListener('change', updateRoleFields);
  requestForm.addEventListener('submit', requestOtp);
  resendButton.addEventListener('click', requestOtp);
  verifyForm.addEventListener('submit', verifyOtp);

  async function requestOtp(event) {
    event?.preventDefault();
    const mobile = mobileInput.value.replace(/\D/g, '');
    const role = roleSelect.value.toUpperCase();
    if (!/^[6-9]\d{9}$/.test(mobile)) {
      showFeedback(initialFeedback, 'Enter a valid 10-digit Indian mobile number.', true);
      mobileInput.focus();
      return;
    }
    if (role === 'CUSTOMER' && nameInput.value.trim().length > 100) {
      showFeedback(initialFeedback, 'Name cannot exceed 100 characters.', true);
      nameInput.focus();
      return;
    }

    setBusy(true);
    try {
      const result = await api('/api/auth/request-otp', {
        method: 'POST',
        body: JSON.stringify({ mobile, role })
      });
      otpRequested = true;
      verifyForm.hidden = false;
      mobileInput.readOnly = true;
      roleSelect.disabled = true;
      showFeedback(
        feedback,
        typeof result.developmentOtp === 'string'
          ? `Development OTP: ${result.developmentOtp}`
          : result.message,
        false
      );
      startCooldown(result.resendAfterSeconds || 60);
      otpInput.focus();
    } catch (error) {
      const seconds = Number(error.retryAfter);
      if (seconds > 0) startCooldown(seconds);
      showFeedback(initialFeedback, error.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(event) {
    event.preventDefault();
    if (!otpRequested) return;
    setBusy(true);
    try {
      const result = await api('/api/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({
          mobile: mobileInput.value.replace(/\D/g, ''),
          role: roleSelect.value.toUpperCase(),
          otp: otpInput.value,
          ...(roleSelect.value === 'customer' ? { fullName: nameInput.value.trim() } : {})
        })
      });
      window.QF.identity = result.user;
      window.location.replace(getNextUrl(result.user.role));
    } catch (error) {
      showFeedback(feedback, error.message, true);
    } finally {
      setBusy(false);
    }
  }

  function updateRoleFields() {
    const customer = roleSelect.value === 'customer';
    nameField.hidden = !customer;
    nameInput.required = false;
  }

  function startCooldown(seconds) {
    window.clearInterval(cooldownTimer);
    let remaining = seconds;
    resendButton.disabled = true;
    resendButton.textContent = `Resend OTP in ${remaining}s`;
    cooldownTimer = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        window.clearInterval(cooldownTimer);
        resendButton.disabled = false;
        resendButton.textContent = 'Resend OTP';
        return;
      }
      resendButton.textContent = `Resend OTP in ${remaining}s`;
    }, 1000);
  }

  function setBusy(busy) {
    requestButton.disabled = busy || otpRequested;
    verifyButton.disabled = busy;
    verifyButton.textContent = busy ? 'Please wait…' : 'Verify and sign in';
  }

  function getNextUrl(role) {
    const candidate = query.get('next');
    if (candidate && candidate.startsWith('/') && !candidate.startsWith('//')) {
      const destination = new URL(candidate, window.location.origin);
      if (destination.origin === window.location.origin) {
        return `${destination.pathname}${destination.search}${destination.hash}`;
      }
    }
    return role === 'PROVIDER' ? '/provider' : '/customer';
  }

  function showFeedback(element, message, isError) {
    element.textContent = message;
    element.classList.toggle('feedback-error', isError);
    element.hidden = false;
  }
})().catch(error => {
  console.error('[UI] Sign-in page could not initialize:', error.message);
});