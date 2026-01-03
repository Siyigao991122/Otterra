-- Create the generations table
CREATE TABLE IF NOT EXISTS generations (
  id VARCHAR(255) PRIMARY KEY,
  user_email VARCHAR(255),
  input_url TEXT NOT NULL,
  outputs JSONB NOT NULL,
  style VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create index on created_at for faster queries
CREATE INDEX IF NOT EXISTS idx_generations_created_at ON generations(created_at DESC);

-- Create index on user_email for user-specific queries
CREATE INDEX IF NOT EXISTS idx_generations_user_email ON generations(user_email);
