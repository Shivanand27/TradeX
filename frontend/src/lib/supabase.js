// src/lib/supabase.js
// ────────────────────────────────────────────────────────
// Supabase client — single instance, shared everywhere.
// Split out from api.js so circular imports are impossible.

import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anon) {
  // Fail loudly at module load — catch this in dev, not at login time.
  // eslint-disable-next-line no-console
  console.error(
    '[tradex] VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set. ' +
    'Copy .env.example to .env.local and fill them in.'
  )
}

export const supabase = createClient(url, anon, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
