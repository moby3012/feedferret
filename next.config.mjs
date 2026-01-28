/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  serverExternalPackages: ["jsdom", "isomorphic-dompurify", "@prisma/client"],
};

export default nextConfig;
