/**
 * dsh-reclaim — host-side plugin entry.
 *
 * Mounts the plugin into the DSH tree and exposes one authenticated health
 * route that reports what the asset-location layer resolved. It is read-only by
 * construction: no service here writes to the user's DSH home.
 *
 * Loader row (published form, see cordis.patch.yml):
 *   - insert: [{ id: reclaim, name: dsh-reclaim }]
 *
 * `inject` lists exactly the services accessed via `ctx.<name>` property
 * access — omitting one makes that access throw
 * (`cannot get property "<name>" without inject`). Services fetched through
 * `ctx.get(name)` bypass inject and are therefore not listed. Registration
 * needs only `connection`.
 */

import { resolveLayout } from './paths.js'

export const name = 'reclaim'
export const inject = ['connection']

/**
 * Format the layout for the health response: the full resolution with the
 * request-image layout decision evidence attached to its family entry.
 */
function healthPayload() {
  const layout = resolveLayout()
  return {
    ok: true,
    plugin: 'dsh-reclaim',
    name,
    home: {
      path: layout.home,
      display: layout.homeDisplay,
      source: layout.homeSource,
    },
    attachmentsRoot: layout.attachmentsRoot,
    families: layout.families,
    trash: { root: layout.trash.root },
  }
}

export function apply(ctx, config) {
  // Accepted and intentionally unused: there is no user-facing configuration
  // yet, so anything passed in is ignored rather than rejected.
  void config

  // Everything the plugin registers goes through ctx.effect() so the host
  // can unwind it on unload (the register call returns its own disposer).
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        // Routes MUST live under /api/ — that prefix is what puts the host's
        // Host/Origin fence and cookie auth in front of the handler.
        path: '/api/dsh-reclaim/health',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            return new Response(JSON.stringify(healthPayload()), {
              headers: { 'content-type': 'application/json' },
            })
          } catch (cause) {
            return new Response(
              JSON.stringify({
                ok: false,
                error: `${cause?.name ?? 'Error'}: ${cause?.message ?? String(cause)}`,
              }),
              {
                status: 500,
                headers: { 'content-type': 'application/json' },
              },
            )
          }
        },
      }),
    'dsh-reclaim: health route',
  )
}
