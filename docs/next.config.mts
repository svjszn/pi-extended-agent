import nextra from 'nextra';
import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

const basePath = process.env.DOCS_BASE_PATH ?? '';
const withNextra = nextra({ contentDirBasePath: '/' });

const config: NextConfig = {
  output: 'export',
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
  experimental: { workerThreads: true, cpus: 2 },
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  webpack(config) {
    config.module.rules.push({
      test: /nextra-theme-docs[\\/]dist[\\/]layout\.js$/,
      use: [{ loader: fileURLToPath(new URL('./loaders/nextra-layout.cjs', import.meta.url)) }],
    });
    return config;
  },
};

export default withNextra(config);
