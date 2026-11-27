const path = require('node:path');
const fs = require('node:fs');

// 本机有 src/custom/private（内容包的源文件）时，测试里装上它（src/custom/sync/jestSetup.ts），连它自己的测试一起跑；
// CUSTOM_BASIC=true 时不装、不跑，只测程序自带的那一份
const usePrivate = process.env.CUSTOM_BASIC !== 'true' && fs.existsSync(path.join(__dirname, 'src/custom/private'));

/** @type { import('jest').Config } */
const config = {
  testEnvironment: 'node',
  testMatch: [
    '**/__tests__/**/*.(spec|test).(m|c)?ts(x)?',
    '**/test/**/*.(spec|test).(m|c)?ts(x)?',
    '**/?(*.)+(spec|test).(m|c)?ts(x)?'
  ],
  transform: {
    '^.+\\.(m|c)?ts?$': ['ts-jest', {
      tsconfig: path.join(__dirname, 'tsconfig.json'),
      useESM: true
    }]
  },
  moduleNameMapper: {
    '^@48tools-api/(.*)$': '<rootDir>/src/services/$1',
    '^__mocks__/(.*)$': '<rootDir>/src/__mocks__/$1'
  },
  testPathIgnorePatterns: ['/node_modules/', ...(usePrivate ? [] : ['[\\\\/]src[\\\\/]custom[\\\\/]private[\\\\/]'])],
  setupFiles: ['<rootDir>/src/custom/sync/jestSetup.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json'],
  collectCoverage: false,
  preset: 'ts-jest/presets/default-esm'
};

module.exports = config;