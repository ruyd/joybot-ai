import path from 'node:path';
import ts from 'typescript';
import { defineConfig, type Plugin } from 'vitest/config';

/** Nest dependency injection needs decorator metadata, which esbuild does not emit. */
function typescriptDecorators(): Plugin {
  return {
    name: 'typescript-decorators',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.ts') || id.includes('node_modules')) return undefined;
      const out = ts.transpileModule(code, {
        fileName: id,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          sourceMap: true,
        },
      });
      return { code: out.outputText, map: out.sourceMapText };
    },
  };
}

export default defineConfig({
  plugins: [typescriptDecorators()],
  esbuild: false,
  resolve: {
    alias: {
      '@joybot/db': path.resolve(__dirname, '../../packages/db/src/index.ts'),
      '@joybot/access': path.resolve(__dirname, '../../packages/access/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'eval/**/*.test.ts'],
    setupFiles: ['test/reset-db.ts'],
    fileParallelism: false,
  },
});
