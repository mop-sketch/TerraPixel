// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { defineConfig } from 'vite';

export default defineConfig({
  /*
   * Where the built page expects to live.
   *
   * Default '/' covers local dev and the single-file build, which is opened straight off disk. A
   * GitHub project site lives under /<repo>/, so the Pages workflow sets PAGES_BASE — passing it as a
   * --base flag instead is a trap on Windows, where the shell rewrites a leading-slash argument into
   * a drive path before Vite ever sees it.
   */
  base: process.env.PAGES_BASE ?? '/',
  server: { port: 5173 },
  build: { target: 'es2022' },
});
