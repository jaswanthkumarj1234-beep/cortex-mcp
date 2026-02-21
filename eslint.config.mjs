import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
        },
        rules: {
            // TypeScript-specific
            '@typescript-eslint/no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_|^e$|^err$|^error$',
                varsIgnorePattern: '^_'
            }],
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-require-imports': 'off',

            // Intentional patterns in this codebase
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-control-regex': 'off',
            'no-useless-escape': 'warn',
            'no-useless-assignment': 'off',

            // Code quality
            'no-console': 'off',
            'prefer-const': 'warn',
            'no-var': 'error',
        },
    },
    {
        ignores: ['dist/**', 'scripts/**', 'bin/**', '*.js', '*.mjs'],
    }
);
