import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier/flat';

export default tseslint.config(
  // Base JS recommended
  eslint.configs.recommended,

  // TypeScript strict + type-checked rules
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  // Type-aware parser options
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Project-specific rule overrides
  {
    rules: {
      // Allow console.error (required for MCP stdio servers — stdout is reserved for JSON-RPC)
      'no-console': ['error', { allow: ['error'] }],

      // Relax for this codebase: catch blocks often use unknown
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      // Allow void for fire-and-forget promises (e.g. file cleanup in finally blocks)
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],

      // Allow unused vars with _ prefix (common pattern for destructuring)
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Disable type-checked rules for JS config files
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },

  // Prettier must be last — turns off conflicting formatting rules
  eslintConfigPrettier,

  // Global ignores
  {
    ignores: ['dist/**', 'node_modules/**', '.agents/**'],
  },
);
