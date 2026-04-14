/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Give long-running cron routes enough room to finish.
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
