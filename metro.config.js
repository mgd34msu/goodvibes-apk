const fs = require('node:fs');
const path = require('node:path');
const { FileStore } = require('metro-cache');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const projectRoot = __dirname;
const metroRoot = path.join(projectRoot, '.metro');
const fileMapRoot = path.join(metroRoot, 'file-map');
const transformRoot = path.join(metroRoot, 'transform-cache');

for (const dir of [metroRoot, fileMapRoot, transformRoot]) {
  fs.mkdirSync(dir, { recursive: true });
}

const config = {
  fileMapCacheDirectory: fileMapRoot,
  cacheStores: [
    new FileStore({
      root: transformRoot,
    }),
  ],
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
