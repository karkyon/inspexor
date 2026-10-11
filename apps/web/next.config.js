/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    // CHG-006: gRPC・ネイティブ依存を含む SDK はバンドルせず Node から直接読む
    serverComponentsExternalPackages: ["@google-cloud/firestore", "@google-cloud/storage", "argon2"],
  },
};
export default nextConfig;
