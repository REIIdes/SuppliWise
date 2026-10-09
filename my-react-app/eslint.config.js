import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Capacitor copies the production bundle into Android assets during a build;
  // those generated third-party files must not be linted as app source.
  globalIgnores(['dist', 'dev-dist', 'android/app/src/main/assets/public']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    // Files that run in NODE, not in a browser, so they get Node's globals.
    //
    // `**/*.test.js` live inside src/ but execute under `node --test` — they
    // import node:fs / node:http and read process.env to spawn real servers.
    // `vite.config.js` and `eslint.config.js` are build tooling and are only
    // ever evaluated by Node.
    //
    // Without this they are linted against browser globals alone, so
    // `process.env.X` is reported as undefined in a file that genuinely has
    // it. That is worse than a cosmetic error: the tempting "fix" is a blanket
    // eslint-disable, which then hides real mistakes for the whole file.
    files: ['**/*.test.js', 'vite.config.js', 'eslint.config.js', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
])
