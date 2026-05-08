/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  images: {
    unoptimized: true,
  },
  serverExternalPackages: [
    "jsdom",
    "isomorphic-dompurify",
    "@prisma/client",
    "bcryptjs",
    "nodemailer",
  ],
};

export default nextConfig;
