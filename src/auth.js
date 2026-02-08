/**
 * Giriş modalı ve oturum kontrolü
 */

function setAuthError(message) {
  const el = document.getElementById('auth-error');
  if (!el) return;
  if (!message) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.style.display = 'block';
  el.textContent = message;
}

function showAuthModal(show) {
  const modal = document.getElementById('auth-modal');
  const header = document.getElementById('main-header');
  if (!modal) return;
  modal.style.display = show ? 'flex' : 'none';
  if (show) {
    if (modal.classList.contains('closing')) modal.classList.remove('closing');
    modal.classList.add('active');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const modalContent = modal.querySelector('.modal-content');
        if (modalContent) {
          modalContent.style.transform = 'scale(1)';
          modalContent.style.opacity = '1';
        }
      });
    });
    document.body.classList.add('auth-open');
    if (header) header.style.display = 'none';
  } else {
    modal.classList.remove('active');
    document.body.classList.remove('auth-open');
    setAuthError('');
    if (header) header.style.display = '';
  }
}

/**
 * Kullanıcı giriş yapana kadar bekler; oturum yoksa login modalı açar
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<Session|null>}
 */
export async function ensureSignedIn(supabase) {
  let session = null;
  try {
    const sessionPromise = supabase.auth.getSession();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Session check timeout')), 10000)
    );
    const { data, error } = await Promise.race([sessionPromise, timeoutPromise]);
    if (error) console.error('Auth session error:', error);
    session = data?.session || null;
  } catch (err) {
    console.error('Error checking session:', err);
    session = null;
  }
  if (session) {
    const authModal = document.getElementById('auth-modal');
    if (authModal) {
      authModal.classList.remove('active');
      authModal.style.display = 'none';
    }
    document.body.classList.remove('auth-open');
    const header = document.getElementById('main-header');
    if (header) header.style.display = '';
    return session;
  }

  showAuthModal(true);
  const loginBtn = document.getElementById('auth-login-btn');
  const loginText = document.getElementById('auth-login-text');
  const loginSpinner = document.getElementById('auth-login-spinner');
  const emailEl = document.getElementById('auth-email');
  const passEl = document.getElementById('auth-password');
  const formEl = document.getElementById('auth-form');
  const toggleBtn = document.getElementById('auth-toggle-password');

  return await new Promise((resolve) => {
    const handler = async () => {
      const email = (emailEl?.value || '').trim();
      const password = passEl?.value || '';
      if (!email || !password) {
        setAuthError('Email ve şifre girin.');
        return;
      }
      setAuthError('');
      loginBtn.disabled = true;
      if (loginSpinner) loginSpinner.style.display = 'inline-block';
      if (loginText) loginText.textContent = 'Giriş yapılıyor...';
      try {
        const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) {
          setAuthError(signInError.message || 'Giriş başarısız.');
          loginBtn.disabled = false;
          if (loginSpinner) loginSpinner.style.display = 'none';
          if (loginText) loginText.textContent = 'Giriş Yap';
          return;
        }
        showAuthModal(false);
        resolve(signInData.session);
      } catch (e) {
        setAuthError(e?.message || 'Giriş başarısız.');
        loginBtn.disabled = false;
        if (loginSpinner) loginSpinner.style.display = 'none';
        if (loginText) loginText.textContent = 'Giriş Yap';
      }
    };

    if (toggleBtn && passEl) {
      toggleBtn.addEventListener('click', () => {
        const isHidden = passEl.type === 'password';
        passEl.type = isHidden ? 'text' : 'password';
        toggleBtn.textContent = isHidden ? 'Gizle' : 'Göster';
      });
    }
    if (formEl) formEl.addEventListener('submit', (e) => { e.preventDefault(); handler(); });
    if (loginBtn) loginBtn.addEventListener('click', handler);
    const keyHandler = (e) => { if (e.key === 'Enter') handler(); };
    if (emailEl) emailEl.addEventListener('keydown', keyHandler);
    if (passEl) passEl.addEventListener('keydown', keyHandler);
  });
}
