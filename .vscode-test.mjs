import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    files: 'out/src/test/vscode/**/*.test.js',
    version: process.env.SNAPTEX_TEST_VSCODE_VERSION || 'stable',
    mocha: { ui: 'tdd', timeout: 20000, forbidOnly: true },
});
