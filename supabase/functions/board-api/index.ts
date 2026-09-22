import { SupabaseStore } from '../_shared/store.mjs';
import { createHandler } from '../_shared/api.mjs';

const store = new SupabaseStore(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const session = new Supabase.ai.Session('gte-small');
Deno.serve(createHandler({
  store,
  authToken: Deno.env.get('TB_AUTH_TOKEN'),
  youtubeKey: Deno.env.get('YOUTUBE_API_KEY'),
  embed: async (text: string) => Array.from(await session.run(text, { mean_pool: true, normalize: true })),
}));
