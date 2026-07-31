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

      // Two rules added in eslint-plugin-react-hooks 7 that this codebase
      // deliberately violates. Both are off at config level rather than
      // sprinkled as per-line disables across 18 sites, so the decision is
      // visible in one place. `exhaustive-deps` stays ON — it's the rule that
      // earns its keep, and the handful of exceptions are disabled per line
      // with a comment explaining each.
      //
      // set-state-in-effect: fires on fetch-on-mount + subscribe-to-realtime,
      // which is exactly what every data hook here does (usePlaces, useTags,
      // useTrips, …). The rule's advice ("you might not need an effect")
      // targets derived state; synchronising with Supabase is the case
      // effects are for.
      'react-hooks/set-state-in-effect': 'off',
      // refs: fires on the "latest ref" idiom — assigning a prop to a ref
      // during render so long-lived callbacks (Mapbox marker handlers, the
      // Escape stack) read current values instead of a stale closure. The
      // alternative is re-subscribing those handlers on every render.
      'react-hooks/refs': 'off',
    },
  },
);
