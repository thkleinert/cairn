import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist'] },
  // The service worker + viewport shim live in public/ and run in their own
  // scopes — lint them with the right globals instead of ignoring them.
  {
    files: ['public/sw.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ['public/viewport.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
);
