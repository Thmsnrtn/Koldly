/**
 * Modal Dialog System
 * Provides confirmation dialogs and other modal interactions
 */

class ModalManager {
  constructor() {
    this.activeModals = new Map();
    this.initStyles();
  }

  initStyles() {
    if (document.getElementById('modal-styles')) return;

    const style = document.createElement('style');
    style.id = 'modal-styles';
    style.textContent = `
      .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9998;
        animation: fadeIn 0.2s ease-out;
      }

      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      .modal {
        background: var(--bg-card, #141414);
        border-radius: 12px;
        padding: 28px;
        max-width: 500px;
        width: 90%;
        max-height: 90vh;
        overflow-y: auto;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3);
        animation: slideUp 0.3s ease-out;
      }

      @keyframes slideUp {
        from {
          transform: translateY(20px);
          opacity: 0;
        }
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }

      .modal-header {
        margin-bottom: 16px;
      }

      .modal-title {
        font-size: 20px;
        font-weight: 700;
        color: var(--text, #FFFFFF);
        margin: 0;
      }

      .modal-body {
        margin-bottom: 24px;
        color: var(--text-muted, #A0A0A0);
        line-height: 1.6;
      }

      .modal-footer {
        display: flex;
        gap: 12px;
        justify-content: flex-end;
      }

      .modal-button {
        padding: 10px 20px;
        border-radius: 6px;
        border: none;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        font-size: 14px;
        min-width: 100px;
      }

      .modal-button-primary {
        background: var(--accent, #FF6B35);
        color: white;
      }

      .modal-button-primary:hover {
        opacity: 0.9;
        transform: translateY(-1px);
      }

      .modal-button-secondary {
        background: var(--border, #1E1E1E);
        color: var(--text, #FFFFFF);
      }

      .modal-button-secondary:hover {
        background: var(--bg-card-hover, #1A1A1A);
      }

      .modal-button-danger {
        background: #EF4444;
        color: white;
      }

      .modal-button-danger:hover {
        opacity: 0.9;
        transform: translateY(-1px);
      }

      .modal-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .modal-close-button {
        position: absolute;
        top: 16px;
        right: 16px;
        background: none;
        border: none;
        color: var(--text-muted, #A0A0A0);
        font-size: 24px;
        cursor: pointer;
        padding: 8px;
      }

      .modal-close-button:hover {
        color: var(--text, #FFFFFF);
      }

      .modal-icon {
        font-size: 32px;
        margin-bottom: 12px;
      }

      @media (max-width: 600px) {
        .modal {
          max-width: 95vw;
          padding: 20px;
        }

        .modal-footer {
          flex-direction: column-reverse;
        }

        .modal-button {
          width: 100%;
        }
      }
    `;
    document.head.appendChild(style);
  }

  create(options = {}) {
    const {
      title = '',
      body = '',
      icon = '',
      buttons = [],
      closeOnEscape = true,
      closeOnOverlay = true
    } = options;

    const id = Math.random().toString(36).substr(2, 9);

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = `modal-overlay-${id}`;

    // Create modal
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = `modal-${id}`;

    // Build modal content
    let html = '';

    if (title) {
      html += `
        <div class="modal-header">
          <h2 class="modal-title">${title}</h2>
        </div>
      `;
    }

    if (icon || body) {
      html += '<div class="modal-body">';
      if (icon) html += `<div class="modal-icon">${icon}</div>`;
      html += body;
      html += '</div>';
    }

    if (buttons.length > 0) {
      html += '<div class="modal-footer">';
      buttons.forEach(btn => {
        const btnClass = btn.type === 'danger' ? 'modal-button-danger' : btn.type === 'primary' ? 'modal-button-primary' : 'modal-button-secondary';
        html += `
          <button class="modal-button ${btnClass}" data-action="${btn.action}"${btn.disabled ? ' disabled' : ''}>
            ${btn.label}
          </button>
        `;
      });
      html += '</div>';
    }

    modal.innerHTML = html;
    overlay.appendChild(modal);

    // Event handlers
    const close = () => {
      overlay.remove();
      this.activeModals.delete(id);
    };

    // Escape key
    if (closeOnEscape) {
      const handleEscape = (e) => {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', handleEscape);
          close();
        }
      };
      document.addEventListener('keydown', handleEscape);
    }

    // Overlay click
    if (closeOnOverlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          close();
        }
      });
    }

    // Button handlers
    modal.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const action = btn.getAttribute('data-action');
        const handler = options.actions?.[action];

        if (handler) {
          btn.disabled = true;
          btn.textContent = btn.getAttribute('data-loading-text') || 'Loading...';
          try {
            await handler();
          } catch (err) {
            console.error('Modal action error:', err);
          } finally {
            btn.disabled = false;
            btn.textContent = buttons.find(b => b.action === action)?.label || 'Button';
          }
        }

        if (action === 'close' || action === 'cancel') {
          close();
        }
      });
    });

    document.body.appendChild(overlay);
    this.activeModals.set(id, overlay);

    return {
      id,
      close,
      element: modal
    };
  }

  confirm(options = {}) {
    return new Promise((resolve) => {
      const {
        title = 'Are you sure?',
        message = '',
        icon = '⚠️',
        confirmText = 'Confirm',
        cancelText = 'Cancel',
        isDangerous = false
      } = typeof options === 'string' ? { message: options } : options;

      this.create({
        title,
        icon,
        body: message,
        buttons: [
          {
            label: cancelText,
            action: 'cancel',
            type: 'secondary'
          },
          {
            label: confirmText,
            action: 'confirm',
            type: isDangerous ? 'danger' : 'primary'
          }
        ],
        actions: {
          confirm: () => {
            resolve(true);
          },
          cancel: () => {
            resolve(false);
          }
        }
      });
    });
  }

  alert(title, message = '') {
    return new Promise((resolve) => {
      this.create({
        title,
        body: message,
        buttons: [
          {
            label: 'OK',
            action: 'ok',
            type: 'primary'
          }
        ],
        actions: {
          ok: () => {
            resolve();
          }
        }
      });
    });
  }

  closeAll() {
    this.activeModals.forEach(overlay => overlay.remove());
    this.activeModals.clear();
  }
}

// Create global instance
const modal = new ModalManager();

// Expose globally
window.showConfirm = (opts) => modal.confirm(opts);
window.showAlert = (title, msg) => modal.alert(title, msg);
window.showModal = (opts) => modal.create(opts);
