/**
 * dsh-reclaim — browser half.
 *
 * This build registers no UI surface: the file exists so the `dsh.client`
 * declaration in package.json resolves to a real, harmless entry instead of a
 * 404.
 *
 * Its shape mirrors the third-party client bundles observable in the wild (a
 * top-level `window.__ModuleLoader__.load({ id, factory })` call whose factory is
 * a CommonJS-style function).
 */

/* global window */
if (typeof window !== 'undefined' && window.__ModuleLoader__?.load) {
  window.__ModuleLoader__.load({
    id: 'dsh-reclaim',
    factory: function () {
      // No UI in this build. Registering nothing is deliberate: an empty
      // surface must not render an empty settings page.
    },
  })
}
