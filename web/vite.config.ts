import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

const EMPTY_GRAMMARS = '\0easy-study:lowlight-common';

/**
 * rehype-highlight keeps a reference to lowlight's `common` grammars (~37 languages, 137 KiB minified)
 * as its default, so the bundler cannot drop them although web/src/lib/markdownOptions.ts always passes
 * its own small set. Replace that module with an empty set.
 */
function dropLowlightCommon(): Plugin {
  return {
    name: 'easy-study:drop-lowlight-common',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './lib/common.js' && importer && /[\\/]node_modules[\\/]lowlight[\\/]index\.js$/.test(importer)) {
        return EMPTY_GRAMMARS;
      }
      return null;
    },
    load(id) {
      return id === EMPTY_GRAMMARS ? 'export const grammars = {};' : null;
    },
  };
}

export default defineConfig({
  root,
  plugins: [dropLowlightCommon(), react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
});
