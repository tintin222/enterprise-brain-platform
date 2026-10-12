import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/node_modules/', '**/dist/', '**/coverage/', 'scripts/spike/results/']),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // The pages run in the browser.
    files: ['packages/brain-web/src/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // CLAUDE.md rule 6: only @brain/shared (ChatClient, RelayClient) talks to upstream libraries.
    // scripts/ is exempt: spike and seed scripts test the raw upstream APIs.
    files: ['packages/bridge/**', 'packages/agent-runtime/**', 'packages/ingestion/**', 'packages/models/**', 'packages/brain/**', 'packages/brain-api/**', 'packages/brain-web/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['nostr-tools', 'nostr-tools/*', '@mattermost/*', '@noble/*', 'ws'],
              message: 'Go through ChatClient / RelayClient in @brain/shared (CLAUDE.md rule 6).',
            },
          ],
        },
      ],
    },
  },
);
