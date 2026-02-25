/**
 * Global Error Handler
 * Catches unhandled errors and shows user-friendly messages
 */

(function() {
  // Track if error boundary is already shown to avoid duplicates
  let errorBoundaryShown = false;

  // Handle unhandled errors
  window.addEventListener('error', function(event) {
    console.error('Unhandled error:', event.error);

    // Only show boundary once
    if (errorBoundaryShown) return;
    errorBoundaryShown = true;

    // Show error notification
    if (typeof showError === 'function') {
      showError('Something Went Wrong', 'Please try refreshing the page or contact support if the problem persists.');
    }

    // Log to console for debugging
    console.error('Full error details:', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error
    });

    // Reset flag after 5 seconds to allow another error to show
    setTimeout(() => {
      errorBoundaryShown = false;
    }, 5000);
  });

  // Handle unhandled promise rejections
  window.addEventListener('unhandledrejection', function(event) {
    console.error('Unhandled promise rejection:', event.reason);

    if (errorBoundaryShown) return;
    errorBoundaryShown = true;

    if (typeof showError === 'function') {
      showError('Something Went Wrong', 'Please try refreshing the page or contact support if the problem persists.');
    }

    console.error('Full rejection details:', event.reason);

    setTimeout(() => {
      errorBoundaryShown = false;
    }, 5000);
  });

  // Intercept fetch errors globally
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    return originalFetch.apply(this, args)
      .catch(err => {
        console.error('Fetch error:', err);
        // Re-throw to let the caller handle it, but log it
        throw err;
      });
  };

  // Helper to handle API errors
  window.handleApiError = function(error, defaultMessage = 'An error occurred') {
    if (typeof error === 'string') {
      if (typeof showError === 'function') {
        showError(defaultMessage, error);
      }
      return;
    }

    const message = error?.error || error?.message || defaultMessage;
    if (typeof showError === 'function') {
      showError(defaultMessage, message);
    }

    console.error('API Error:', error);
  };

  // Network status monitoring
  window.addEventListener('online', function() {
    if (typeof showInfo === 'function') {
      showInfo('Connection restored');
    }
  });

  window.addEventListener('offline', function() {
    if (typeof showWarning === 'function') {
      showWarning('No internet connection', 'Some features may not work offline.');
    }
  });
})();
