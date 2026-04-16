/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    '@cezar/core',
    '@anthropic-ai/sdk',
    '@anthropic-ai/claude-agent-sdk',
    '@octokit/rest',
    'cosmiconfig',
  ],
  experimental: {
    typedRoutes: false,
  },
};

export default nextConfig;
