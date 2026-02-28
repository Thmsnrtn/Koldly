/**
 * Jest Setup File
 * Runs before all tests
 */

// Set test environment
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-key-do-not-use-in-production';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
process.env.STRIPE_SECRET_KEY = '';
process.env.PORT = 3001;

// Silence logs during tests (unless DEBUG is set)
if (!process.env.DEBUG) {
  global.console.log = jest.fn();
  global.console.error = jest.fn();
  global.console.warn = jest.fn();
}

// Increase timeout for slower tests
jest.setTimeout(10000);
