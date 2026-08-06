import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Required by the container build in tad.md Section 6.1: the standalone
  // output is what keeps the image within its size budget. Set now because it
  // constrains later choices.
  output: 'standalone',
};

export default nextConfig;
