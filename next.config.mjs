/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];
const allowForwarded = process.env.NODE_ENV !== 'production' || !!process.env.CODESPACES || !!process.env.CODESPACE_NAME;
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['pg', 'bcryptjs', 'embedded-postgres'],
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
      // GitHub Codespaces forwards requests from https://<name>-3000.app.github.dev to localhost:3000.
      // Allow that origin in development (npm run dev) and whenever we run inside a codespace.
      allowedOrigins: allowForwarded ? ['*.app.github.dev', 'localhost:3000'] : undefined,
    },
  },
  allowedDevOrigins: ['*.app.github.dev'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};
export default nextConfig;
