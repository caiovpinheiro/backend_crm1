import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Mocka `@/lib/prisma-base` por padrão (banco vazio) — elimina os
    // "Unhandled Rejection" do query engine em testes que importam serviços
    // sem mockar o Prisma. Um `vi.mock` no próprio teste tem precedência.
    setupFiles: ["./src/test-setup/mock-prisma-base.ts"],
  },
});
