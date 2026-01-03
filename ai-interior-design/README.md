# AI Interior Design

Transform your space with AI-powered interior design. Upload a photo of your room and get 3 professional design variations in your chosen style.

## Features

- 🎨 Multiple design styles (modern, minimalist, industrial, scandinavian, etc.)
- 🤖 AI-powered design generation using Replicate's Flux model
- 📸 Upload room photos and get instant redesigns
- 💾 Persistent storage with Vercel Postgres
- 🎯 Clean, modern UI with shadcn/ui components
- ⚡ Built with Next.js 14 App Router

## Tech Stack

- **Framework:** Next.js 14 with App Router
- **Language:** TypeScript
- **Styling:** Tailwind CSS
- **UI Components:** shadcn/ui
- **AI Model:** Replicate Flux Schnell
- **Database:** Vercel Postgres
- **Deployment:** Vercel

## Getting Started

### Prerequisites

- Node.js 18+ installed
- A Replicate API account ([replicate.com](https://replicate.com))
- A Vercel account with Postgres enabled

### Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd ai-interior-design
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:

Create a `.env.local` file in the root directory:

```env
# Replicate API
REPLICATE_API_TOKEN=your_replicate_api_token_here

# Vercel Postgres (automatically provided by Vercel)
POSTGRES_URL=your_postgres_url
POSTGRES_PRISMA_URL=your_postgres_prisma_url
POSTGRES_URL_NO_SSL=your_postgres_url_no_ssl
POSTGRES_URL_NON_POOLING=your_postgres_url_non_pooling
POSTGRES_USER=your_postgres_user
POSTGRES_HOST=your_postgres_host
POSTGRES_PASSWORD=your_postgres_password
POSTGRES_DATABASE=your_postgres_database
```

### Database Setup

1. **On Vercel:** Add Vercel Postgres to your project through the Vercel dashboard

2. **Run the schema:** Execute the SQL from `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS generations (
  id VARCHAR(255) PRIMARY KEY,
  user_email VARCHAR(255),
  input_url TEXT NOT NULL,
  outputs JSONB NOT NULL,
  style VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_generations_created_at ON generations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generations_user_email ON generations(user_email);
```

You can run this in the Vercel Postgres dashboard or using the Vercel CLI:

```bash
vercel env pull .env.local
```

Then connect to your database and run the schema.

### Get Your Replicate API Token

1. Go to [replicate.com](https://replicate.com)
2. Sign up or log in
3. Navigate to your account settings
4. Generate an API token
5. Copy the token to your `.env.local` file

### Run the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the application.

## Project Structure

```
ai-interior-design/
├── app/
│   ├── api/
│   │   └── generate/
│   │       └── route.ts          # API endpoint for AI generation
│   ├── create/
│   │   └── page.tsx               # Upload and style selection page
│   ├── results/
│   │   └── [id]/
│   │       └── page.tsx           # Results display page
│   ├── layout.tsx                 # Root layout
│   ├── page.tsx                   # Landing page
│   └── globals.css                # Global styles
├── components/
│   └── ui/                        # shadcn/ui components
├── lib/
│   └── utils.ts                   # Utility functions
├── schema.sql                     # Database schema
├── .env.example                   # Environment variables template
└── README.md
```

## How It Works

1. **Upload:** User uploads a room photo on `/create`
2. **Style Selection:** User chooses a design style (modern, minimalist, etc.)
3. **AI Generation:**
   - Image is converted to base64
   - Replicate Flux API generates 3 design variations
   - Each variation uses the prompt: "interior design, [style], photorealistic, professional"
4. **Storage:** Generation is saved to Postgres with:
   - Unique ID
   - Original image (base64)
   - Generated images (URLs)
   - Style and timestamp
5. **Results:** User is redirected to `/results/[id]` to view designs

## API Routes

### POST `/api/generate`

Generates AI interior designs.

**Request:**
- Method: POST
- Content-Type: multipart/form-data
- Body:
  - `image` (File): Room image
  - `style` (string): Design style
  - `email` (string, optional): User email

**Response:**
```json
{
  "id": "uuid",
  "outputs": ["url1", "url2", "url3"],
  "style": "modern"
}
```

## Deployment

### Deploy to Vercel

1. Push your code to GitHub

2. Import your repository to Vercel

3. Add environment variables in Vercel dashboard:
   - `REPLICATE_API_TOKEN`

4. Add Vercel Postgres:
   - Go to Storage tab
   - Create Postgres database
   - Postgres env variables are automatically added

5. Run the database schema in Vercel Postgres dashboard

6. Deploy!

```bash
vercel --prod
```

## Available Design Styles

- Modern
- Minimalist
- Industrial
- Scandinavian
- Bohemian
- Traditional
- Contemporary
- Rustic

## Cost Considerations

- **Replicate:** ~$0.003 per image generation (Flux Schnell)
- **Vercel Postgres:** Free tier available, paid plans for production
- **Vercel Hosting:** Free tier for personal projects

For 3 variations per request: ~$0.009 per generation

## Development Tips

### Using Claude Code (for backend setup)

Perfect for:
- API route implementation
- Database schema setup
- TypeScript configurations
- Backend logic and integrations

### Using Cursor (for frontend)

Perfect for:
- Visual design iteration
- Component styling
- UI/UX improvements
- Testing user flows

## Troubleshooting

### Images Not Generating

1. Check your Replicate API token is valid
2. Verify you have credits in your Replicate account
3. Check the browser console for errors

### Database Errors

1. Ensure Vercel Postgres is properly configured
2. Verify the schema has been applied
3. Check environment variables are set

### Large Image Files

The current implementation uses base64 encoding. For production:
- Consider using Vercel Blob for image storage
- Implement image compression
- Add file size limits (currently no limit)

## Future Enhancements

- [ ] User authentication
- [ ] Save favorite designs
- [ ] Share designs with a public URL
- [ ] More design styles
- [ ] Room type detection
- [ ] Before/after comparison slider
- [ ] Download all designs as ZIP
- [ ] Email notifications when complete
- [ ] Payment integration for premium features

## License

MIT

## Support

For issues and questions, please open an issue on GitHub.
