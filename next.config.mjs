/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  /** Native `@napi-rs/canvas` + pdf.js must run in Node, not Webpack/Turbopack bundles. */
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
}

export default nextConfig
