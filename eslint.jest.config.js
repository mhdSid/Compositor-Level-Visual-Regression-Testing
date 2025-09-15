export default {
  verbose: false,
  reporters: [
    'default'
  ],
  roots: ['<rootDir>'],
  moduleFileExtensions: ['js', 'ts', 'json', 'node'],
  testMatch: [
    '<rootDir>/**/*.js',
    '<rootDir>/**/*.ts',
    '<rootDir>/*.js',
    '<rootDir>/*.ts'
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/coverage/',
    '/jest-html-reporters-attach'
  ],
  runner: 'jest-runner-eslint',
  watchPlugins: ['jest-runner-eslint/watch-fix']
}
