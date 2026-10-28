import { createOwnerSession } from './owner-session.mjs';
import { session } from './session.js';
import router from '@/router';
import { permsToRouter } from '@/perm/perm.js';
import { useUserStore } from '@/store/user.js';
import { useAccountStore } from '@/store/account.js';
import { useEmailStore } from '@/store/email.js';
import { useSendStore } from '@/store/send.js';
import { userDraftStore } from '@/store/draft.js';
import { useWriterStore } from '@/store/writer.js';

// Reset display caches, never the email-keyed Dexie drafts.
export function ownerSession() {
  return createOwnerSession({
    session,
    router,
    userStore: useUserStore(),
    accountStore: useAccountStore(),
    caches: [useEmailStore(), useSendStore(), userDraftStore(), useWriterStore()],
    routesFor: permsToRouter
  });
}
