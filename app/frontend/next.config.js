/** @type {import('next').NextConfig} */
const nextConfig = {
  output: process.env.NEXT_BUILD_TARGET === 'standalone' ? 'standalone' : undefined,
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
