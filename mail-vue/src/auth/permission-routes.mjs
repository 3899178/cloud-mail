const removers = new WeakMap();
export function clearPermissionRoutes(router) {
  for (const remove of removers.get(router) || []) remove();
  removers.delete(router);
}
export function installPermissionRoutes(router, routes) {
  clearPermissionRoutes(router);
  removers.set(router, routes.map(route => router.addRoute('layout', route)));
}
