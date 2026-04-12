import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

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
        projectService: {
          allowDefaultProject: ['*.js', '*.mjs'],
        },
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

  // Test files: disable projectService, use explicit project + relaxed rules
  {
    files: ['__tests__/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.test.json',
      },
    },
    rules: {
      // describe/it return promises in Node's test runner — top-level floating is expected
      '@typescript-eslint/no-floating-promises': 'off',
      // Mock stubs are often empty
      '@typescript-eslint/no-empty-function': 'off',
      // Mock callbacks often don't need await
      '@typescript-eslint/require-await': 'off',
      // Test assertions use bracket notation for flexibility
      '@typescript-eslint/dot-notation': 'off',
      // doesNotThrow expects void-returning callbacks
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // Test assertions with mock data may use unsafe types
      '@typescript-eslint/no-unsafe-argument': 'off',
      // Unnecessary condition checks after assert.ok() are fine in tests
      '@typescript-eslint/no-unnecessary-condition': 'off',
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
