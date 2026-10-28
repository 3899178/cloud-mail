import { createSession } from './session-core.mjs';
export const session = createSession({
  storage: localStorage,
  fetcher: (...args) => fetch(...args),
  base: import.meta.env.VITE_BASE_URL || '/api'
});
