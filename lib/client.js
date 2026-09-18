/**
 * dsh-reclaim — browser half.
 *
 * Registers no UI surface: this build has no settings panel, and registering
 * nothing is deliberate — an empty surface must not render an empty settings
 * page. The file exists because `package.json` declares `dsh.client`, and that
 * declaration has to resolve to a real, harmless entry instead of a 404.
 *
 * The shape mirrors the third-party client bundles observable in the installed
 * host: a top-level `window.__ModuleLoader__.load({ id, factory })` call whose
 * factory is a CommonJS-style function. `id` is the PACKAGE name
 * (`dsh-reclaim`), not the loader row id: the host keys client bundles by the
 * package name it resolves from the manifest, and a mismatch is rejected with
 * `bundle … loaded without registering "<id>"`.
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
