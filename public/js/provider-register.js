(async () => {
  await window.QF.ready;
  const { api, setProviderId } = window.QF;
  const form = document.getElementById('provider-registration-form');
  const feedback = document.getElementById('registration-feedback');
  const dashboardLink = document.getElementById('provider-dashboard-link');
  const submitButton = document.getElementById('register-provider');

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const formData = new FormData(form);
    const mobile = String(formData.get('mobile') || '').replace(/\D/g, '');
    const pincode = String(formData.get('pincode') || '').trim();
    if (!/^[6-9]\d{9}$/.test(mobile)) {
      showFeedback('Enter a valid 10-digit Indian mobile number.', true);
      form.elements.mobile.focus();
      return;
    }
    if (!/^\d{6}$/.test(pincode)) {
      showFeedback('Enter a valid 6-digit pincode.', true);
      form.elements.pincode.focus();
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Submitting…';
    try {
      const result = await api('/api/providers/register', {
        method: 'POST',
        body: JSON.stringify({
          name: String(formData.get('name') || '').trim(),
          mobile,
          service: String(formData.get('service') || ''),
          experience: Number(formData.get('experience')),
          address: String(formData.get('address') || '').trim(),
          area: String(formData.get('area') || '').trim(),
          pincode
        })
      });
      if (window.QF.authenticationEnabled) {
        dashboardLink.href = '/login?role=provider';
        dashboardLink.textContent = 'Sign in after verification';
        showFeedback(
          'Registration submitted. Sign in with this mobile number after your profile is verified.',
          false
        );
      } else {
        setProviderId(result.provider.id);
        showFeedback('Registration submitted. Your profile is pending verification.', false);
      }
      dashboardLink.hidden = false;
      form.reset();
    } catch (error) {
      showFeedback(error.message, true);
    } finally {
      submitButton.disabled = false;
      submitButton.innerHTML = 'Submit for verification <span aria-hidden="true">→</span>';
    }
  });

  function showFeedback(message, isError) {
    feedback.textContent = message;
    feedback.classList.toggle('feedback-error', isError);
    feedback.hidden = false;
  }
})().catch(error => {
  console.error('[UI] Provider registration could not initialize:', error.message);
});
