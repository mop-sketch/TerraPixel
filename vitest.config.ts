// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /*
     * The balance matrix is excluded from the default run and lives behind `npm run test:balance`.
     *
     * It simulates several sim-months across eight scenarios and takes minutes, not seconds. Left in
     * the default suite it would make the fast feedback loop slow enough that people stop running it,
     * which costs far more than the coverage is worth. CI runs both.
     */
    exclude: ['**/node_modules/**', 'tests/balance.test.ts'],
    testTimeout: 60_000,
  },
});
