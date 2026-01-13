// Supabase public config (safe to expose in frontend: URL + anon key)
// Prefer Cloudflare Pages env -> build generates dist/env.js, and we read from window.__MEKANAPP_ENV__.
// Fallback: you can hardcode local values below if running without the build step.
const env = (typeof window !== 'undefined' && window.__MEKANAPP_ENV__) ? window.__MEKANAPP_ENV__ : {};

export const SUPABASE_URL = env.SUPABASE_URL || 'https://pajszftukmypoheqzxqh.supabase.co';
export const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY || 'sb_publishable_SLww15gQlgFAOV0H8XhD6A_bLMiCWtU';

