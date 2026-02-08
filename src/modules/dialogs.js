/**
 * Uygulama diyalogları: alert, confirm, loading overlay
 */

export function initAppDialog() {
  if (this._dialog) return;
  const modal = document.getElementById('app-dialog');
  const titleEl = document.getElementById('app-dialog-title');
  const messageEl = document.getElementById('app-dialog-message');
  const confirmBtn = document.getElementById('app-dialog-confirm-btn');
  const cancelBtn = document.getElementById('app-dialog-cancel-btn');
  const closeBtn = document.getElementById('app-dialog-close');
  if (!modal || !titleEl || !messageEl || !confirmBtn || !cancelBtn || !closeBtn) return;

  this._dialog = { modal, titleEl, messageEl, confirmBtn, cancelBtn, closeBtn };

  const closeWith = (value) => {
    if (!this._dialogResolver) return;
    const resolver = this._dialogResolver;
    this._dialogResolver = null;
    try {
      const activeEl = document.activeElement;
      if (activeEl && modal.contains(activeEl)) activeEl.blur();
    } catch (_) {}
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    resolver(value);
  };

  confirmBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeWith(true); });
  cancelBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeWith(false); });
  closeBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeWith(false); });
  modal.addEventListener('click', (e) => { if (e.target === modal) closeWith(false); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) closeWith(false);
  });
}

export async function appAlert(message, title = 'Uyarı') {
  await this.appDialog({ mode: 'alert', title, message });
}

export async function appConfirm(message, { title = 'Onay', confirmText = 'Evet', cancelText = 'Vazgeç', confirmVariant = 'primary' } = {}) {
  return await this.appDialog({ mode: 'confirm', title, message, confirmText, cancelText, confirmVariant });
}

export function appDialog({ mode = 'alert', title = 'Uyarı', message = '', confirmText = 'Tamam', cancelText = 'İptal', confirmVariant = 'primary' } = {}) {
  this.initAppDialog();
  if (!this._dialog) return Promise.resolve(mode === 'confirm' ? false : true);
  const { modal, titleEl, messageEl, confirmBtn, cancelBtn } = this._dialog;

  confirmBtn.classList.remove('btn-danger', 'btn-primary');
  confirmBtn.classList.add(confirmVariant === 'danger' ? 'btn-danger' : 'btn-primary');
  confirmBtn.textContent = confirmText;
  cancelBtn.textContent = cancelText;
  cancelBtn.style.display = mode === 'confirm' ? 'inline-flex' : 'none';
  titleEl.textContent = title;
  messageEl.textContent = message;

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
  modal.setAttribute('aria-hidden', 'false');
  return new Promise((resolve) => { this._dialogResolver = resolve; });
}

export function showLoadingOverlay(message = 'İşleniyor...') {
  const overlay = document.getElementById('loading-overlay');
  const messageEl = document.getElementById('loading-message');
  if (overlay) {
    if (messageEl) messageEl.textContent = message;
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }
}

export function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    document.body.style.overflow = '';
  }
}
