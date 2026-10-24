// Flat ESLint config: @eslint/js + typescript-eslint recommended + react-hooks.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // supabase/functions is Deno code with its own checker (deno check, deferred).
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'supabase/functions/**'],
  },
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Node-side files: scripts, tests and tool configs.
    files: ['scripts/**', 'tests/**', '*.config.{ts,js}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // src/core and src/shared are pure and are synced into the Deno edge function:
    // they must not import UI, Supabase or Node modules.
    files: ['src/core/**', 'src/shared/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react/*', 'react-dom', 'react-dom/*', '@supabase/*', 'node:*', 'vite', 'vitest'],
              message: 'src/core and src/shared must stay pure (no UI, Supabase, Node or test imports).',
            },
          ],
        },
      ],
    },
  },
);
