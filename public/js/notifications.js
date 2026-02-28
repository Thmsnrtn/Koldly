/**
 * Global Notification System
 * Provides toast notifications for user feedback across the app
 */

class NotificationManager {
  constructor() {
    this.container = null;
    this.notifications = new Map();
    this.init();
  }

  init() {
    // Create notification container if it doesn't exist
    if (!document.getElementById('notification-container')) {
      this.container = document.createElement('div');
      this.container.id = 'notification-container';
      this.container.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 9999;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      `;

      // Add styles
      if (!document.getElementById('notification-styles')) {
        const style = document.createElement('style');
        style.id = 'notification-styles';
        style.textContent = `
          .notification {
            background: #1A1A1A;
            border-radius: 8px;
            padding: 16px 20px;
            margin-bottom: 12px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
            display: flex;
            align-items: center;
            gap: 12px;
            max-width: 400px;
            pointer-events: auto;
            animation: slideIn 0.3s ease-out;
            min-height: 44px;
            border: 1px solid #333;
          }

          @keyframes slideIn {
            from {
              transform: translateX(400px);
              opacity: 0;
            }
            to {
              transform: translateX(0);
              opacity: 1;
            }
          }

          @keyframes slideOut {
            from {
              transform: translateX(0);
              opacity: 1;
            }
            to {
              transform: translateX(400px);
              opacity: 0;
            }
          }

          .notification.removing {
            animation: slideOut 0.3s ease-out;
          }

          .notification-icon {
            font-size: 20px;
            flex-shrink: 0;
          }

          .notification-content {
            flex: 1;
          }

          .notification-title {
            font-weight: 600;
            color: #F5F5F5;
            font-size: 14px;
            margin: 0;
          }

          .notification-message {
            color: #A0A0A0;
            font-size: 13px;
            margin: 4px 0 0 0;
          }

          .notification-close {
            background: none;
            border: none;
            color: #666;
            cursor: pointer;
            font-size: 20px;
            padding: 0;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            transition: color 0.2s;
          }

          .notification-close:hover {
            color: #F5F5F5;
          }

          /* Notification types */
          .notification.success {
            border-left: 4px solid #10B981;
          }

          .notification.success .notification-icon {
            color: #10B981;
          }

          .notification.error {
            border-left: 4px solid #EF4444;
          }

          .notification.error .notification-icon {
            color: #EF4444;
          }

          .notification.warning {
            border-left: 4px solid #F59E0B;
          }

          .notification.warning .notification-icon {
            color: #F59E0B;
          }

          .notification.info {
            border-left: 4px solid #3B82F6;
          }

          .notification.info .notification-icon {
            color: #3B82F6;
          }

          /* Mobile */
          @media (max-width: 600px) {
            .notification {
              max-width: calc(100vw - 40px);
              margin-bottom: 8px;
            }

            .notification-title {
              font-size: 13px;
            }

            .notification-message {
              font-size: 12px;
            }

            #notification-container {
              top: 10px !important;
              right: 10px !important;
              left: 10px !important;
            }
          }
        `;
        document.head.appendChild(style);
      }

      document.body.appendChild(this.container);
    } else {
      this.container = document.getElementById('notification-container');
    }
  }

  show(options) {
    const {
      type = 'info',
      title = '',
      message = '',
      duration = 4000,
      icon = null
    } = typeof options === 'string' ? { message: options } : options;

    const id = Math.random().toString(36).substr(2, 9);

    const notification = document.createElement('div');
    notification.className = `notification ${type}`;

    const icons = {
      success: '✓',
      error: '✕',
      warning: '⚠',
      info: 'ℹ'
    };

    notification.innerHTML = `
      <div class="notification-icon">${icon || icons[type] || '•'}</div>
      <div class="notification-content">
        ${title ? `<p class="notification-title">${title}</p>` : ''}
        ${message ? `<p class="notification-message">${message}</p>` : ''}
      </div>
      <button class="notification-close" aria-label="Close notification">×</button>
    `;

    const closeBtn = notification.querySelector('.notification-close');
    const remove = () => {
      notification.classList.add('removing');
      setTimeout(() => {
        notification.remove();
        this.notifications.delete(id);
      }, 300);
    };

    closeBtn.addEventListener('click', remove);

    this.container.appendChild(notification);
    this.notifications.set(id, notification);

    if (duration > 0) {
      setTimeout(remove, duration);
    }

    return id;
  }

  success(title, message) {
    if (typeof title !== 'string') {
      message = title;
      title = 'Success';
    }
    return this.show({ type: 'success', title, message });
  }

  error(title, message) {
    if (typeof title !== 'string') {
      message = title;
      title = 'Error';
    }
    return this.show({ type: 'error', title, message, duration: 6000 });
  }

  warning(title, message) {
    if (typeof title !== 'string') {
      message = title;
      title = 'Warning';
    }
    return this.show({ type: 'warning', title, message });
  }

  info(title, message) {
    if (typeof title !== 'string') {
      message = title;
      title = 'Info';
    }
    return this.show({ type: 'info', title, message });
  }

  remove(id) {
    const notification = this.notifications.get(id);
    if (notification) {
      notification.classList.add('removing');
      setTimeout(() => {
        notification.remove();
        this.notifications.delete(id);
      }, 300);
    }
  }

  clear() {
    this.notifications.forEach(notification => {
      notification.remove();
    });
    this.notifications.clear();
  }
}

// Create global instance
const notif = new NotificationManager();

// Expose globally
window.showNotification = (opts) => notif.show(opts);
window.showSuccess = (title, msg) => notif.success(title, msg);
window.showError = (title, msg) => notif.error(title, msg);
window.showWarning = (title, msg) => notif.warning(title, msg);
window.showInfo = (title, msg) => notif.info(title, msg);
