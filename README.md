# Otterra - AI Interior Design Studio

Transform your space with AI-powered interior design. Upload floor plans, visualize in 3D, and get personalized furniture recommendations.

## Environment Variables

**Important:** Environment variables must be set in `.env.local` (project root, same level as `package.json`), **not** typed into the terminal.

1. Copy `.env.local.example` to `.env.local` (or create `.env.local` with the required keys).
2. Replace the placeholders with your real values from Supabase (Dashboard → Settings → API).
3. **After changing `.env.local`, restart the dev server** (`npm run dev`).

## Development

```bash
npm install --legacy-peer-deps
npm run dev
```

If port 3000 is in use, Next.js will use the next available port (e.g. 3001). Check the terminal output for the actual URL.

- Homepage: http://localhost:3001 (or whatever port Next prints)
- Waitlist: http://localhost:3001/waitlist
