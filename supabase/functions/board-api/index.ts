import { SupabaseStore } from '../_shared/store.mjs';
import { createHandler } from '../_shared/api.mjs';
import { createEmbedder } from '../_shared/embeddings.mjs';

const store = new SupabaseStore(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
let session: { run: (input: string, options: Record<string, unknown>) => Promise<ArrayLike<number>> } | undefined;
const embedder = createEmbedder({
  EMBEDDING_API_URL: Deno.env.get('EMBEDDING_API_URL'),
  EMBEDDING_API_KEY: Deno.env.get('EMBEDDING_API_KEY'),
  EMBEDDING_MODEL: Deno.env.get('EMBEDDING_MODEL'),
}, () => (session ??= new Supabase.ai.Session('gte-small')));
Deno.serve(createHandler({
  store,
  authToken: Deno.env.get('TB_AUTH_TOKEN'),
  youtubeKey: Deno.env.get('YOUTUBE_API_KEY'),
  embed: embedder.embed,
  embeddingModel: embedder.model,
}));
