/**
 * Form Utilities
 * Provides consistent form validation, error display, and UX patterns
 */

class FormManager {
  constructor() {
    this.initStyles();
  }

  initStyles() {
    if (document.getElementById('form-styles')) return;

    const style = document.createElement('style');
    style.id = 'form-styles';
    style.textContent = `
      .form-group {
        margin-bottom: 20px;
      }

      .form-group label {
        display: block;
        margin-bottom: 8px;
        font-weight: 600;
        font-size: 14px;
        color: var(--text, #FFFFFF);
      }

      .form-group input,
      .form-group textarea,
      .form-group select {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid var(--border, #333);
        border-radius: 6px;
        background: var(--input-bg, #0F0F0F);
        color: var(--text, #FFFFFF);
        font-size: 14px;
        font-family: inherit;
        transition: all 0.2s;
      }

      .form-group input:focus,
      .form-group textarea:focus,
      .form-group select:focus {
        outline: none;
        border-color: var(--accent, #FF6B35);
        box-shadow: 0 0 0 3px rgba(255, 107, 53, 0.1);
      }

      .form-group input::placeholder,
      .form-group textarea::placeholder {
        color: var(--text-muted, #888);
      }

      /* Error state */
      .form-group.error input,
      .form-group.error textarea,
      .form-group.error select {
        border-color: #EF4444;
        background: rgba(239, 68, 68, 0.05);
      }

      .form-group.error input:focus,
      .form-group.error textarea:focus,
      .form-group.error select:focus {
        box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.1);
      }

      .form-error {
        display: block;
        color: #EF4444;
        font-size: 12px;
        margin-top: 6px;
        line-height: 1.4;
      }

      .form-helper {
        display: block;
        color: var(--text-muted, #888);
        font-size: 12px;
        margin-top: 6px;
      }

      /* Success state */
      .form-group.success input,
      .form-group.success textarea,
      .form-group.success select {
        border-color: #10B981;
      }

      .form-group.success input:focus,
      .form-group.success textarea:focus,
      .form-group.success select:focus {
        box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.1);
      }

      /* Password strength meter */
      .password-strength {
        height: 4px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 2px;
        margin-top: 6px;
        overflow: hidden;
      }

      .password-strength-bar {
        height: 100%;
        border-radius: 2px;
        transition: all 0.3s;
        width: 0%;
      }

      .password-strength-bar.weak {
        width: 33%;
        background: #EF4444;
      }

      .password-strength-bar.fair {
        width: 66%;
        background: #F59E0B;
      }

      .password-strength-bar.strong {
        width: 100%;
        background: #10B981;
      }

      .password-strength-text {
        font-size: 12px;
        margin-top: 4px;
        color: var(--text-muted, #888);
      }

      /* Button disabled state */
      button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      /* Inline form layouts */
      .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }

      @media (max-width: 600px) {
        .form-row {
          grid-template-columns: 1fr;
        }
      }

      /* Required indicator */
      .form-required {
        color: #EF4444;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Check password strength
   */
  getPasswordStrength(password) {
    let strength = 0;

    if (!password) return { score: 0, label: 'Too weak', className: 'weak' };

    if (password.length >= 10) strength++;
    if (password.length >= 14) strength++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) strength++;
    if (/\d/.test(password)) strength++;
    if (/[^a-zA-Z\d]/.test(password)) strength++;

    if (strength <= 2) return { score: 1, label: 'Weak', className: 'weak' };
    if (strength <= 3) return { score: 2, label: 'Fair', className: 'fair' };
    return { score: 3, label: 'Strong', className: 'strong' };
  }

  /**
   * Add validation to a form field
   */
  addValidation(inputElement, rules = {}) {
    const group = inputElement.closest('.form-group') || inputElement.parentElement;

    // Add real-time validation on input
    inputElement.addEventListener('input', () => {
      this.validateField(inputElement, rules, group);
    });

    // Trim whitespace on blur for email/text fields
    if (inputElement.type === 'email' || inputElement.type === 'text') {
      inputElement.addEventListener('blur', () => {
        inputElement.value = inputElement.value.trim();
      });
    }

    return {
      validate: () => this.validateField(inputElement, rules, group),
      clear: () => this.clearFieldError(group)
    };
  }

  /**
   * Validate a single field
   */
  validateField(field, rules = {}, container = null) {
    const group = container || field.closest('.form-group');
    const value = field.value.trim();

    // Clear previous errors
    this.clearFieldError(group);

    // Check required
    if (rules.required && !value) {
      this.setFieldError(group, rules.requiredMessage || 'This field is required');
      return false;
    }

    // Check email
    if (rules.email && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      this.setFieldError(group, 'Please enter a valid email address');
      return false;
    }

    // Check min length
    if (rules.minLength && value && value.length < rules.minLength) {
      this.setFieldError(group, `Must be at least ${rules.minLength} characters`);
      return false;
    }

    // Check max length
    if (rules.maxLength && value && value.length > rules.maxLength) {
      this.setFieldError(group, `Must be no more than ${rules.maxLength} characters`);
      return false;
    }

    // Check password strength
    if (rules.password && value) {
      const strength = this.getPasswordStrength(value);
      if (strength.score < 3) {
        this.setFieldError(group, 'Password must be stronger. Use uppercase, numbers, and special characters.');
        return false;
      }
    }

    // Check pattern
    if (rules.pattern && value && !rules.pattern.test(value)) {
      this.setFieldError(group, rules.patternMessage || 'Invalid format');
      return false;
    }

    // Custom validation
    if (rules.custom) {
      const error = rules.custom(value);
      if (error) {
        this.setFieldError(group, error);
        return false;
      }
    }

    // All checks passed
    this.setFieldSuccess(group);
    return true;
  }

  /**
   * Set field error state
   */
  setFieldError(group, message) {
    group.classList.add('error');
    group.classList.remove('success');

    let errorEl = group.querySelector('.form-error');
    if (!errorEl) {
      errorEl = document.createElement('div');
      errorEl.className = 'form-error';
      group.appendChild(errorEl);
    }
    errorEl.textContent = message;
  }

  /**
   * Set field success state
   */
  setFieldSuccess(group) {
    group.classList.add('success');
    group.classList.remove('error');

    const errorEl = group.querySelector('.form-error');
    if (errorEl) errorEl.remove();
  }

  /**
   * Clear field error
   */
  clearFieldError(group) {
    group.classList.remove('error', 'success');
    const errorEl = group.querySelector('.form-error');
    if (errorEl) errorEl.remove();
  }

  /**
   * Add password strength meter
   */
  addPasswordStrengthMeter(passwordField) {
    const group = passwordField.closest('.form-group');

    // Create meter if not exists
    if (!group.querySelector('.password-strength')) {
      const meter = document.createElement('div');
      meter.className = 'password-strength';
      meter.innerHTML = '<div class="password-strength-bar"></div>';

      const text = document.createElement('div');
      text.className = 'password-strength-text';

      const container = passwordField.nextElementSibling;
      if (container) {
        container.parentElement.insertBefore(meter, container);
        container.parentElement.insertBefore(text, container);
      } else {
        group.appendChild(meter);
        group.appendChild(text);
      }
    }

    // Update on input
    passwordField.addEventListener('input', () => {
      const strength = this.getPasswordStrength(passwordField.value);
      const bar = group.querySelector('.password-strength-bar');
      const text = group.querySelector('.password-strength-text');

      bar.className = `password-strength-bar ${strength.className}`;
      text.textContent = `Password strength: ${strength.label}`;
    });
  }

  /**
   * Validate entire form
   */
  validateForm(form) {
    const fields = form.querySelectorAll('[data-validate]');
    let isValid = true;

    fields.forEach(field => {
      const rules = this.parseRules(field.getAttribute('data-validate'));
      if (!this.validateField(field, rules)) {
        isValid = false;
      }
    });

    return isValid;
  }

  /**
   * Parse validation rules from data attribute
   */
  parseRules(ruleString) {
    const rules = {};
    if (!ruleString) return rules;

    ruleString.split('|').forEach(rule => {
      const [name, value] = rule.split(':');
      if (name === 'required') rules.required = true;
      else if (name === 'email') rules.email = true;
      else if (name === 'minLength') rules.minLength = parseInt(value);
      else if (name === 'maxLength') rules.maxLength = parseInt(value);
      else if (name === 'password') rules.password = true;
    });

    return rules;
  }

  /**
   * Disable form while submitting
   */
  setFormLoading(form, isLoading = true) {
    const buttons = form.querySelectorAll('button[type="submit"]');
    const inputs = form.querySelectorAll('input, textarea, select');

    buttons.forEach(btn => {
      btn.disabled = isLoading;
      if (isLoading) {
        btn.setAttribute('data-original-text', btn.textContent);
        btn.textContent = 'Loading...';
      } else {
        btn.textContent = btn.getAttribute('data-original-text') || btn.textContent;
      }
    });

    inputs.forEach(input => {
      input.disabled = isLoading;
    });
  }
}

// Create global instance
const form = new FormManager();

// Expose globally
window.validateForm = (formEl) => form.validateForm(formEl);
window.addFormValidation = (field, rules) => form.addValidation(field, rules);
