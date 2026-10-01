import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'spike', 'logs'] },
  ...tseslint.configs.recommended,
);
