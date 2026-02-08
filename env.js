/**
 * MekanApp ortam değişkenleri (istemci tarafında yüklenir).
 * Build sırasında (build.mjs) bu dosya dist/env.js olarak üzerine yazılabilir.
 *
 * Burada saklanabilecekler (hepsi tarayıcıda görünür, gizli bilgi koymayın):
 * - SUPABASE_URL: Supabase proje URL'iniz
 * - SUPABASE_ANON_KEY: Supabase anon (public) anahtarınız
 *
 * İsteğe bağlı (ileride kullanılabilir):
 * - API_BASE_URL, özel backend varsa
 * - FEATURE_FLAGS vb. (public ayarlar)
 */
window.__MEKANAPP_ENV__ = window.__MEKANAPP_ENV__ || {};
