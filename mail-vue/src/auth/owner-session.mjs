import { clearPermissionRoutes, installPermissionRoutes } from './permission-routes.mjs';
export function createOwnerSession({
  session,
  router,
  userStore,
  accountStore,
  caches,
  routesFor
}) {
  const clear = () => {
    clearPermissionRoutes(router);
    for (const store of [userStore, accountStore, ...caches]) store.$reset();
  };
  session.onReset = clear;
  return {
    async load(loadUser) {
      try {
        const user = await loadUser();
        if (!user?.email || !user.account || !Array.isArray(user.permKeys)) throw new Error('USER_UNAVAILABLE');
        clear();
        userStore.user = user;
        accountStore.currentAccountId = user.account.accountId;
        accountStore.currentAccount = user.account;
        installPermissionRoutes(router, routesFor(user.permKeys));
        return user;
      } catch (error) {
        session.reset();
        throw error;
      }
    }
  };
}
