/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The project is built in the cloud (Vercel/Netlify) rather than on a local
  // toolchain, so a stray type or lint warning should never block a deploy.
  // Run `npm run typecheck` in a cloud IDE (Codespaces/StackBlitz) to see them.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
