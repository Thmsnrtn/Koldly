/**
 * Jest Configuration for Koldly
 *
 * Runs unit and integration tests with proper setup/teardown
 */

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'lib/**/*.js',
    'server.js',
    '!lib/scheduler.js', // Skip scheduler for now
    '!lib/email-service.js' // Skip complex services
  ],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 50,
      lines: 50,
      statements: 50
    }
  },
  verbose: true,
  testTimeout: 10000,
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js']
};
