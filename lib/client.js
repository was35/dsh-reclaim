/**
 * dsh-reclaim — the browser half.
 *
 * Registers the plugin's settings section: an audit view where a person can see what is
 * reclaimable, why, and clean it up into a recoverable quarantine.
 *
 * ---------------------------------------------------------------------------
 * ## The bundle shape is not a style choice — it is measured
 * ---------------------------------------------------------------------------
 *
 * The host reads `exports["./client"]` and concatenates it with other plugins' bundles
 * into **classic scripts**, then executes them in the page. So this file must be valid as
 * a classic script:
 *
 *   - **no top-level `export`** — a module-level `export` is a syntax error in a classic
 *     script, and the whole bundle dies with `Unexpected token 'export'` and a blank
 *     settings page. Measured in a real browser.
 *   - **no `import`** — same reason. External modules arrive through the factory's
 *     `require`.
 *   - the bundle's only load-time act is registering a factory:
 *     `window.__ModuleLoader__.load({ id, factory })`.
 *
 * ## What this half depends on
 *
 * `react`, from the factory's `require` — verified present in other installed plugins'
 * bundles, so the shell provides it. Plus this package's own `lib/messages.js`, because
 * that file is pure data that both halves can be checked against. Nothing else,
 * deliberately: every additional module is another way for the settings page to come up
 * blank with no server-side error to look at.
 *
 * ## The interface rules that are acceptance criteria, not polish
 *
 *   1. **A dangerous row cannot be selected.** Its checkbox is disabled and the reason is
 *      printed next to it. Letting a user tick it and then refusing would deliver the same
 *      information at the worst possible moment.
 *   2. **A row that cannot be batch-cleared does not get a checkbox.** It gets a
 *      "still clean up…" entry that states what the family-wide action would move and
 *      which conditions block the batch route. A disabled checkbox is a dead control;
 *      an entry point that explains itself is not.
 *   3. **"Clean up" and "empty permanently" must never look alike.** The first moves data
 *      into the quarantine and is reversible; the second destroys it.
 *   4. **The top bar reports the live tree, the quarantine and the net release
 *      separately.** A user who clears 50 MB and then sees total usage rise by 50 MB
 *      concludes the plugin lied — and they would be right, because a quarantine is not a
 *      delete.
 *
 * ## Two kinds of row, and they are cleared by two different routes
 *
 * The three session tiers answer "which sessions can go". A second card answers a different
 * question — "what can be cleared without touching a session?" — and holds the rebuildable
 * cache families and the attachment objects. The split is not cosmetic: a checked session row
 * sends its **id** to `POST /delete`, which also settles that session's workspace and job
 * accounting, while a checked row in the second card sends its **id** to `POST /clear` and the
 * server re-derives the paths from a scan it takes itself. **This panel never names a file**,
 * so it cannot name the wrong one — `docs/safety.md` §8.5 is the lesson: a caller's self-report
 * (`body.risk`) authorized nothing, and a caller-supplied path would authorize less.
 *
 * A row in the second card that cannot be cleared is still listed, with its reason, and gets a
 * disabled checkbox rather than the "still clean up…" entry rule 2 describes. The difference is
 * that rule 2's entry point offers an *alternative* action (the family-wide move, with its
 * blocking conditions spelled out); a cache family that was never enumerated has no alternative
 * to offer, so the honest shape is the reason beside a control that does not work.
 *
 * ## Layout: grouped by workspace, ordered for cleanup
 *
 * The rows are grouped by workspace and ordered the way the host's own sidebar is, because
 * that is the surface the user already reads (group order = most recently active first).
 * **Inside** a group the order is reversed — most idle first — because that is what a
 * cleanup view is for. Group order answers "where have I been working"; row order answers
 * "what should go".
 */

;(function () {
  'use strict'

  var LOCALE_NS = 'dsh-reclaim'

  /**
   * The panel's stylesheet, injected at materialization time.
   *
   * A `<style>` tag inside the factory is exactly the shape the module loader documents
   * ("every module body side effect, including CSS injection, lives inside the factory
   * closure"). Class names are prefixed `dshr-`; the group/tier/row vocabulary mirrors the
   * host sidebar's so the two read as siblings.
   */
  var STYLE_ID = 'dsh-reclaim-panel-style'
  var CSS = [
    '.dshr-root{display:flex;flex-direction:column;gap:14px;max-width:920px;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:20px}',
    '.dshr-card{border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
    '.dshr-top{display:flex;flex-wrap:wrap;gap:18px;align-items:baseline}',
    '.dshr-top b{font-size:15px}',
    '.dshr-muted{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.9));font-size:12px}',
    '.dshr-net-pos{color:var(--dsw-alias-state-success-primary,#2e9e5b)}',
    '.dshr-net-neg{color:var(--dsw-alias-state-error-primary,#d14343)}',
    '.dshr-tier{display:flex;flex-direction:column;gap:6px}',
    '.dshr-tier>h4{margin:0;font-size:13px;display:flex;gap:8px;align-items:baseline}',
    '.dshr-badge{border-radius:6px;padding:0 6px;font-size:11px;border:.5px solid currentColor}',
    '.dshr-badge-danger{color:var(--dsw-alias-state-error-primary,#d14343)}',
    '.dshr-badge-confirm{color:var(--dsw-alias-state-warn-primary,#b4771a)}',
    '.dshr-badge-safe{color:var(--dsw-alias-state-success-primary,#2e9e5b)}',
    '.dshr-group{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.22));padding-top:8px;margin-top:8px}',
    '.dshr-group:first-child{border-top:0;padding-top:0;margin-top:0}',
    '.dshr-group-head{display:flex;align-items:baseline;gap:8px;cursor:pointer;background:0 0;border:0;color:inherit;font:inherit;padding:4px 0;text-align:left}',
    '.dshr-group-title{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dshr-group-meta{margin-left:auto;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.9));font-size:12px;white-space:nowrap}',
    '.dshr-caret{width:12px;display:inline-block;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.9))}',
    '.dshr-rows{display:flex;flex-direction:column;padding-left:14px}',
    '.dshr-row{display:flex;flex-direction:column;gap:4px;padding:6px 0;border-top:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.14))}',
    '.dshr-rows>.dshr-row:first-child{border-top:0}',
    '.dshr-row-head{display:flex;gap:8px;align-items:baseline}',
    '.dshr-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}',
    '.dshr-row-time{margin-left:auto;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.9));font-size:12px;white-space:nowrap}',
    '.dshr-row-id{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.75))}',
    '.dshr-metrics{display:flex;flex-wrap:wrap;gap:10px}',
    '.dshr-reasons{display:flex;flex-direction:column;gap:2px}',
    '.dshr-reasons span{color:var(--dsw-alias-state-warn-primary,#b4771a)}',
    '.dshr-thresholds{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
    '.dshr-thresholds button,.dshr-actions button,.dshr-bin button,.dshr-review button{border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:transparent;color:inherit;font:inherit;border-radius:6px;padding:4px 10px;cursor:pointer}',
    '.dshr-thresholds button[aria-pressed="true"]{border-color:var(--dsw-alias-state-business-primary,#4b7bec);color:var(--dsw-alias-state-business-primary,#4b7bec)}',
    '.dshr-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}',
    '.dshr-actions .dshr-primary{border-color:var(--dsw-alias-state-business-primary,#4b7bec)}',
    '.dshr-review{border:.5px solid var(--dsw-alias-state-warn-primary,#b4771a);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;margin-top:4px}',
    '.dshr-review-title{font-weight:600}',
    '.dshr-review ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px}',
    '.dshr-review li{color:var(--dsw-alias-state-warn-primary,#b4771a)}',
    '.dshr-danger-zone{border:.5px solid var(--dsw-alias-state-error-primary,#d14343);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;margin-top:8px}',
    '.dshr-danger-zone h4{margin:0;color:var(--dsw-alias-state-error-primary,#d14343);font-size:13px}',
    '.dshr-danger-zone button.dshr-destroy{border-color:var(--dsw-alias-state-error-primary,#d14343);color:var(--dsw-alias-state-error-primary,#d14343)}',
    '.dshr-disabled{opacity:.6}',
    '.dshr-error{color:var(--dsw-alias-state-error-primary,#d14343)}',
    '.dshr-checkbox{display:flex;align-items:center;gap:6px}',
    '.dshr-scroll{max-height:460px;overflow:auto}',
  ].join('\n')

  function injectStyles() {
    if (typeof document === 'undefined') return
    if (document.getElementById(STYLE_ID) !== null) return
    var style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }

  /** Human-readable byte size. The unit follows the value rather than being fixed. */
  function formatBytes(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '?'
    if (value < 1024) return value + ' B'
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
    if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB'
    return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  }

  /**
   * Relative time, short form — the same shape the host sidebar uses
   * (`15分钟` / `22小时` / `1天`), so a row reads the same in both surfaces.
   */
  function formatRelative(ms, locale) {
    if (typeof ms !== 'number' || !isFinite(ms)) return null
    var minutes = Math.max(0, Math.round((Date.now() - ms) / 60000))
    if (minutes < 1) return locale === 'en' ? 'just now' : '刚刚'
    if (minutes < 60) return locale === 'en' ? minutes + 'm' : minutes + '分钟'
    var hours = Math.round(minutes / 60)
    if (hours < 24) return locale === 'en' ? hours + 'h' : hours + '小时'
    var days = Math.round(hours / 24)
    return locale === 'en' ? days + 'd' : days + '天'
  }

  /** One `/api/dsh-reclaim/*` request. The host's cookie is sent automatically. */
  function api(path, options) {
    var init = { headers: { 'content-type': 'application/json' } }
    if (options !== undefined) {
      if (options.method !== undefined) init.method = options.method
      if (options.body !== undefined) init.body = JSON.stringify(options.body)
    }
    return fetch(path, init).then(function (response) {
      return response.text().then(function (text) {
        var body = null
        try {
          body = text === '' ? null : JSON.parse(text)
        } catch (cause) {
          body = { ok: false, error: 'the route returned non-JSON (HTTP ' + response.status + ')' }
        }
        if (!response.ok && body !== null && body.error === undefined) body.error = 'HTTP ' + response.status
        return { status: response.status, ok: response.ok, body: body }
      })
    })
  }

  /**
   * A translator for the panel's own copy.
   *
   * The host's locale service is preferred — `bind(ns)` resolves against whatever language the
   * service is in, which is the intended way to follow it — and the bundled dictionary is the
   * fallback for a deployment that has no locale service at all (`A9c`: degrade, do not crash).
   *
   * ## Why the language is passed IN rather than only read from the service
   *
   * Measured in a real host: after a language switch, `document.documentElement.lang` was already
   * `en` while `ctx.locale.getLocale().active` still said `zh`. The service instance this plugin is
   * handed does not always carry the language the interface just adopted, so the panel that followed
   * only the service rendered the PREVIOUS language — the defect this parameter fixes. The caller
   * resolves the language once (document first, service second, see `readActiveLocale`) and both the
   * copy and the relative-time format use that single answer, so they cannot disagree.
   */
  function createTranslator(ctx, messages, locale) {
    var bundle = messages ?? null
    var bound = null
    var local = bundle !== null && typeof bundle.translatePanel === 'function' ? bundle.translatePanel : localTranslate
    if (ctx !== undefined && ctx !== null && ctx.locale !== undefined && ctx.locale !== null) {
      if (typeof ctx.locale.bind === 'function') {
        try {
          bound = ctx.locale.bind(LOCALE_NS)
        } catch (cause) {
          bound = null
        }
      }
    }
    return function t(key, params) {
      if (bound !== null) {
        try {
          var value = bound(key, params)
          // The host returns the key itself when it has no entry; prefer our own dictionary then.
          // That also covers the window between materialization and dictionary registration, during
          // which `bind` resolves nothing.
          if (value !== undefined && value !== null && value !== key) return String(value)
        } catch (cause) {
          bound = null
        }
      }
      return local(locale === undefined || locale === null ? 'zh' : locale, key, params)
    }
  }

  /**
   * The language the panel should render in, from the host's own locale snapshot.
   *
   * Used only for the few things a dictionary cannot express (the relative-time format is
   * chosen from the current language). The text itself always comes from `t`.
   */
  function readActiveLocale(ctx) {
    // 1. The document's own language, which is what the interface around the panel is rendered in.
    //
    // This is the authoritative answer to "which language should this panel speak?", and it is the
    // one that stays correct: measured in a real host, `ctx.locale.getLocale().active` can still say
    // `zh` while `document.documentElement.lang` already says `en` — the service instance this plugin
    // is handed does not always carry the language the settings surface just adopted. Taking the
    // service's word in that state is exactly how the panel ended up in the previous language.
    try {
      if (typeof document !== 'undefined' && document.documentElement !== null) {
        var declared = document.documentElement.getAttribute('lang')
        if (typeof declared === 'string' && declared.length > 0) {
          // `en`, `en-US`, `zh`, `zh-CN` all reduce to the base tag the dictionaries are keyed by.
          var base = declared.split('-')[0].toLowerCase()
          if (INLINE_MESSAGES.PANEL_MESSAGES[base] !== undefined) return base
        }
      }
    } catch (cause) {
      /* fall through to the service */
    }
    // 2. The locale service, when the document did not declare anything usable.
    try {
      if (ctx !== undefined && ctx !== null && ctx.locale !== undefined && typeof ctx.locale.getLocale === 'function') {
        var snapshot = ctx.locale.getLocale()
        if (snapshot !== null && snapshot !== undefined && typeof snapshot.active === 'string') {
          var active = snapshot.active.split('-')[0].toLowerCase()
          if (INLINE_MESSAGES.PANEL_MESSAGES[active] !== undefined) return active
        }
      }
    } catch (cause) {
      /* reported by the caller's fallback */
    }
    return 'zh'
  }

  /**
   * Re-render when the interface language changes.
   *
   * Two signals, because either one can be the one that fires: the locale service's own subscription,
   * and the document's `lang` attribute (which the host rewrites on every language change and which,
   * measured, can lead the service instance this plugin holds). A `MutationObserver` on that attribute
   * is what makes an in-place switch visible even when the service stays quiet.
   */
  function useLocaleRevision(react, ctx) {
    var stateHook = react.useState(0)
    var bump = stateHook[1]
    react.useEffect(function () {
      var bumpOnce = function () {
        bump(function (value) {
          return value + 1
        })
      }
      var disposers = []
      var service = ctx !== undefined && ctx !== null ? ctx.locale : null
      if (service !== null && service !== undefined && typeof service.subscribe === 'function') {
        var unsubscribe = service.subscribe(bumpOnce)
        if (typeof unsubscribe === 'function') disposers.push(unsubscribe)
      }
      if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
        var observer = new MutationObserver(bumpOnce)
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
        disposers.push(function () {
          observer.disconnect()
        })
      }
      return function () {
        for (var index = 0; index < disposers.length; index += 1) disposers[index]()
      }
    }, [])
    return stateHook[0]
  }

  // --- ordering and grouping -------------------------------------------------

  /**
   * Most idle first; ties broken by size, biggest first.
   *
   * A cleanup view wants the oldest candidates at the top. Rows whose age could not be read
   * (`ageDays === null`) sort last: "unknown" is not "old", and putting them first would
   * present unmeasured sessions as the best candidates.
   */
  function compareRowsForCleanup(left, right) {
    var leftAge = left.facts !== undefined && typeof left.facts.ageDays === 'number' ? left.facts.ageDays : null
    var rightAge = right.facts !== undefined && typeof right.facts.ageDays === 'number' ? right.facts.ageDays : null
    if (leftAge === null && rightAge !== null) return 1
    if (leftAge !== null && rightAge === null) return -1
    if (leftAge !== null && rightAge !== null && leftAge !== rightAge) return rightAge - leftAge
    var leftSize = (left.facts !== undefined && left.facts.sizeBytes) || 0
    var rightSize = (right.facts !== undefined && right.facts.sizeBytes) || 0
    if (leftSize !== rightSize) return rightSize - leftSize
    return String(left.id).localeCompare(String(right.id))
  }

  /** The last path segment, used when the registry has no display name for a workspace. */
  function lastPathSegment(path) {
    if (typeof path !== 'string' || path.length === 0) return null
    var parts = path.replace(/[\\/]+$/, '').split(/[\\/]+/)
    return parts[parts.length - 1] || null
  }

  /**
   * The sentence beside a row that explains why it is not offered for clearing.
   *
   * This panel's translation table is a *subset* of the reason codes the server can emit, and
   * the two are versioned separately — the server ships codes, the panel ships strings. So the
   * fallback is the server's own message rather than the raw code: a code shown to a person is
   * a bug report nobody filed, while the server's message at least says what happened.
   */
  function reasonText(t, check) {
    var translated = t('reason.' + check.code)
    if (translated !== 'reason.' + check.code) return translated
    return check.message
  }

  /**
   * A session id in the form the rest of the system uses.
   *
   * The report identifies sessions by bare uuid (`classifySession` uses `session.id` for its
   * keys), while the session table, the API and every log line use `session-<uuid>`. The panel
   * is where a person copies an id to cross-reference, so it must print the form those other
   * surfaces use — an id that cannot be pasted into a request or a log search is not an id.
   */
  function sessionIdOf(value) {
    if (typeof value !== 'string' || value.length === 0) return null
    return value.startsWith('session-') ? value : 'session-' + value
  }

  /**
   * Group rows by workspace, in the order the host's sidebar shows them.
   *
   * The sidebar's order is "most recently active first". It is derived here from the
   * newest activity in each group, which reproduces that order without needing the
   * registry's own ordering to be carried through the report.
   *
   * A row with no readable workspace path lands in its own group keyed by the empty
   * string; the label then says so rather than inventing a name.
   */
  function groupByWorkspace(rows) {
    var groups = new Map()
    for (var index = 0; index < rows.length; index += 1) {
      var row = rows[index]
      var facts = row.facts !== undefined ? row.facts : {}
      var label = facts.workspaceLabel !== undefined && facts.workspaceLabel !== null ? facts.workspaceLabel : null
      var path = facts.workspacePath !== undefined && facts.workspacePath !== null ? facts.workspacePath : null
      if (label === null) label = lastPathSegment(path)
      var key = path === null ? '' : path
      if (!groups.has(key)) groups.set(key, { key: key, label: label, path: path, rows: [], newest: null })
      var group = groups.get(key)
      group.rows.push(row)
      if (typeof facts.lastActivity === 'number' && (group.newest === null || facts.lastActivity > group.newest)) {
        group.newest = facts.lastActivity
      }
    }
    var list = Array.from(groups.values())
    for (var each = 0; each < list.length; each += 1) list[each].rows.sort(compareRowsForCleanup)
    list.sort(function (left, right) {
      if (left.newest === null && right.newest === null) return String(left.key).localeCompare(String(right.key))
      if (left.newest === null) return 1
      if (right.newest === null) return -1
      if (left.newest !== right.newest) return right.newest - left.newest
      return String(left.key).localeCompare(String(right.key))
    })
    return list
  }

  /** How many rows in this group are in the given tier. */
  function countTier(group, tier) {
    var count = 0
    for (var index = 0; index < group.rows.length; index += 1) if (group.rows[index].tier === tier) count += 1
    return count
  }

  /** Family membership, so the review entry can state the family's real size. */
  function familyIndex(report) {
    var bySession = new Map()
    var families = Array.isArray(report.families) ? report.families : []
    for (var index = 0; index < families.length; index += 1) {
      var family = families[index]
      var members = Array.isArray(family.memberIds) ? family.memberIds : []
      for (var member = 0; member < members.length; member += 1) {
        bySession.set(members[member], { id: family.id, memberIds: members })
      }
    }
    return bySession
  }

  /**
   * Render the whole panel from data plus interaction state, with no hooks.
   *
   * Kept separate from the component on purpose: this function holds every rule that
   * matters to a user — what a row may be selected, where the destructive action lives, how
   * the byte figures are labelled, which group a row belongs to — and being hook-free means
   * it can be rendered and asserted **without a DOM or a browser**.
   */
  function renderPanel(react, input, handlers) {
    var h = react.createElement
    var t = input.t
    var locale = input.locale
    var status = input.status
    var error = input.error
    var report = input.report
    var trash = input.trash
    var thresholdDays = input.thresholdDays
    var view = input.view
    var selected = input.selected
    var busy = input.busy
    var notice = input.notice
    var reviewOpen = input.reviewOpen
    var collapsed = input.collapsed

    if (status === 'loading') {
      return h('div', { className: 'dshr-root' }, h('div', { className: 'dshr-muted' }, t('state.loading')))
    }
    if (status === 'error') {
      return h(
        'div',
        { className: 'dshr-root' },
        h('div', { className: 'dshr-error' }, t('state.loadFailed', { error: error })),
        h('div', { className: 'dshr-actions' }, h('button', { type: 'button', onClick: handlers.refresh }, t('state.retry'))),
      )
    }

    var tiers = (report.tiers && report.tiers.sessions) || {}
    var cacheTiers = (report.tiers && report.tiers.caches) || {}
    var attachmentTiers = (report.tiers && report.tiers.attachments) || {}
    var families = familyIndex(report)
    var footprint = (trash && trash.footprint) || null
    var quarantineBytes = footprint === null ? 0 : footprint.bytes || 0
    var totals = report.totals || {}
    var reclaimable = totals.totalReclaimableBytes || 0
    // The net release is a subtraction the user can check by hand: what a cleanup would
    // free, minus what it parks in the quarantine.
    var netRelease = reclaimable - quarantineBytes
    var gate = report.gate || {}

    var sourceLine = t('top.source', {
      sessions: totals.sessionCount || 0,
      attachments: totals.dedupAttachmentCount || 0,
      families: (report.families || []).length,
      scan: report.scanCount === undefined ? '?' : report.scanCount,
    })
    if (gate.orphanDeterminationAllowed === false) {
      sourceLine = sourceLine + ' · ⚠ ' + t('top.pending', { count: (gate.unknownSessions || []).length })
    }

    /**
     * One tier, rendered as workspace groups.
     *
     * Safe and confirm rows carry their own control; danger rows are listed but not
     * actionable, with the reason beside them.
     */
    function renderTier(tier) {
      var rows = (Array.isArray(tiers[tier]) ? tiers[tier] : []).slice().sort(compareRowsForCleanup)
      var groups = groupByWorkspace(rows)
      var body
      if (rows.length === 0) {
        body = h('div', { className: 'dshr-muted' }, t(tier === 'safe' ? 'tier.safeEmpty' : tier === 'confirm' ? 'tier.confirmEmpty' : 'tier.dangerEmpty'))
      } else {
        body = h(
          'div',
          { className: 'dshr-scroll', 'data-dshr-tier-body': tier },
          groups.map(function (group) {
            var isCollapsed = collapsed.has(group.key)
            return h(
              'div',
              { className: 'dshr-group', key: group.key === '' ? '(unknown-workspace)' : group.key, 'data-dshr-group': group.key },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshr-group-head',
                  'aria-expanded': !isCollapsed,
                  'data-dshr-group-toggle': group.key,
                  onClick: function () {
                    handlers.toggleGroup(group.key)
                  },
                },
                h('span', { className: 'dshr-caret' }, isCollapsed ? '▸' : '▾'),
                h('span', { className: 'dshr-group-title' }, group.label === null ? group.key || '—' : group.label),
                h(
                  'span',
                  { className: 'dshr-group-meta' },
                  t('tier.count', { count: group.rows.length }) +
                    (group.newest === null ? '' : ' · ' + (formatRelative(group.newest, locale) || '')),
                ),
              ),
              // The rows are a SIBLING of the header button, never its child: a button must
              // not contain interactive content (the rows carry checkboxes and their own
              // buttons), and a screen reader would lose the whole group into the toggle.
              // This paren was missing once and the rows silently became button children —
              // visible only by dumping the tree.
              isCollapsed
                ? null
                : h(
                    'div',
                    { className: 'dshr-rows' },
                    group.rows.map(function (row) {
                      return renderRow(react, row, tier, {
                        t: t,
                        locale: locale,
                        selected: selected,
                        toggle: handlers.toggle,
                        reviewOpen: reviewOpen,
                        toggleReview: handlers.toggleReview,
                        family: families.get(row.id) || null,
                        busy: busy,
                        cleanFamily: handlers.cleanFamily,
                      })
                    }),
                  ),
            )
          }),
        )
      }
      return h(
        'div',
        { className: 'dshr-tier', 'data-dshr-tier': tier },
        h(
          'h4',
          null,
          h('span', { className: 'dshr-badge dshr-badge-' + tier }, t('tier.' + tier)),
          h('span', { className: 'dshr-muted' }, t('tier.count', { count: rows.length })),
        ),
        body,
      )
    }

    /**
     * The rows that are not sessions: rebuildable cache families, and attachment objects.
     *
     * They get their own card instead of being folded into the three session tiers, because a
     * checkbox here means something different. A checked session row sends its **id** to
     * `POST /delete`, which also settles that session's workspace and job accounting. A checked
     * row here sends its **id** to `POST /clear`, and the server re-derives the paths from a
     * scan it takes itself — this panel never names a file, so it cannot name the wrong one.
     *
     * Rows that are not offered for clearing are still listed, with the reason. "We did not read
     * it" is an answer, and it is the answer that explains the missing checkbox; hiding the row
     * would leave a person wondering where their disk went.
     */
    function renderClearables() {
      var groups = [
        { key: 'caches', buckets: ['safe', 'confirm', 'unclassified', 'danger', 'reportOnly'], tiers: cacheTiers },
        { key: 'attachments', buckets: ['safe', 'confirm', 'danger', 'unclassified'], tiers: attachmentTiers },
      ]
      var entries = []
      groups.forEach(function (group) {
        group.buckets.forEach(function (bucket) {
          ;(group.tiers[bucket] || []).forEach(function (row) {
            entries.push({ row: row, bucket: bucket })
          })
        })
      })
      if (entries.length === 0) return null

      function clearableRow(entry) {
        var row = entry.row
        var facts = row.facts || {}
        var blocking = (row.blockingChecks || []).filter(function (check) {
          return check.ok === false
        })
        var selectable = row.tier === 'safe' && row.batchClearable === true
        var metrics = [t('clear.size', { size: formatBytes(row.bytes) })]
        if (typeof facts.files === 'number') metrics.push(t('clear.files', { count: facts.files }))
        if (typeof facts.path === 'string' && facts.path.length > 0) metrics.push(facts.path)

        return h(
          'div',
          {
            key: row.id,
            className: 'dshr-row' + (selectable ? '' : ' dshr-disabled'),
            'data-dshr-row': row.id,
            'data-dshr-kind': row.kind,
          },
          h(
            'div',
            { className: 'dshr-row-head' },
            h(
              'label',
              { className: 'dshr-checkbox' },
              h('input', {
                type: 'checkbox',
                // Written down rather than implied by the absence of an attribute, for the same
                // reason the session rows do it: "this control is usable" is the property the
                // whole rule turns on.
                disabled: !selectable,
                checked: selectable ? selected.has(row.id) : false,
                onChange: function () {
                  handlers.toggle(row.id)
                },
                'aria-label': row.id,
                'data-dshr-selectable': selectable ? 'true' : 'false',
                'data-dshr-tier': row.tier,
              }),
            ),
            h('span', { className: 'dshr-row-title' }, t('clear.kind.' + row.kind)),
            h('span', { className: 'dshr-row-time' }, t('clear.tier.' + row.tier)),
          ),
          h('div', { className: 'dshr-row-id' }, row.id),
          h(
            'div',
            { className: 'dshr-metrics dshr-muted' },
            metrics.map(function (text, index) {
              return h('span', { key: index }, text)
            }),
          ),
          blocking.length === 0
            ? null
            : h(
                'div',
                { className: 'dshr-reasons' },
                blocking.map(function (check) {
                  return h('span', { key: check.code }, '· ' + reasonText(t, check))
                }),
              ),
        )
      }

      return h(
        'div',
        { className: 'dshr-card', 'data-dshr-clearables': 'true' },
        h(
          'h4',
          null,
          h('span', { className: 'dshr-badge' }, t('clear.title')),
          h('span', { className: 'dshr-muted' }, t('clear.count', { count: entries.length })),
        ),
        h('div', { className: 'dshr-muted' }, t('clear.note')),
        h(
          'div',
          { className: 'dshr-rows' },
          entries.map(clearableRow),
        ),
      )
    }

    return h(
      'div',
      { className: 'dshr-root' },
      h(
        'div',
        { className: 'dshr-card' },
        h(
          'div',
          { className: 'dshr-top' },
          h('div', null, h('b', null, formatBytes(reclaimable)), h('div', { className: 'dshr-muted' }, t('top.reclaimable'))),
          h(
            'div',
            null,
            h('b', { 'data-dshr-quarantine': String(quarantineBytes) }, formatBytes(quarantineBytes)),
            h('div', { className: 'dshr-muted' }, t('top.quarantine')),
          ),
          h(
            'div',
            null,
            h(
              'b',
              { className: netRelease >= 0 ? 'dshr-net-pos' : 'dshr-net-neg', 'data-dshr-net': String(netRelease) },
              formatBytes(netRelease),
            ),
            h('div', { className: 'dshr-muted' }, t('top.netRelease')),
          ),
        ),
        h('div', { className: 'dshr-muted' }, sourceLine),
        h(
          'div',
          { className: 'dshr-thresholds', role: 'group', 'aria-label': t('threshold.group') },
          [7, 14, 30, 90].map(function (days) {
            return h(
              'button',
              {
                key: days,
                type: 'button',
                'aria-pressed': thresholdDays === days,
                'data-dshr-threshold': String(days),
                onClick: function () {
                  handlers.setThresholdDays(days)
                },
              },
              t('threshold.days', { days: days }),
            )
          }),
          h('span', { className: 'dshr-muted' }, t('threshold.note')),
        ),
      ),

      notice === null || notice === undefined
        ? null
        : h('div', { className: notice.kind === 'ok' ? 'dshr-card' : 'dshr-card dshr-error' }, notice.text),

      h(
        'div',
        { className: 'dshr-actions' },
        h(
          'button',
          { type: 'button', 'aria-pressed': view === 'audit', onClick: function () { handlers.setView('audit') } },
          t('view.audit'),
        ),
        h(
          'button',
          { type: 'button', 'aria-pressed': view === 'bin', onClick: function () { handlers.setView('bin') } },
          footprint === null
            ? t('view.bin')
            : t('view.binWithCount', { batches: footprint.batches, size: formatBytes(quarantineBytes) }),
        ),
        h('span', { style: { flex: 1 } }),
        h(
          'button',
          { type: 'button', onClick: handlers.refresh, disabled: status === 'refreshing' },
          status === 'refreshing' ? t('action.rescanning') : t('action.rescan'),
        ),
      ),

      view === 'audit'
        ? h('div', { className: 'dshr-card' }, renderTier('safe'), renderTier('confirm'), renderTier('danger'))
        : renderBin(react, trash, handlers, busy, t),

      view === 'audit' ? renderClearables() : null,

      view === 'audit'
        ? h(
            'div',
            { className: 'dshr-card dshr-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshr-primary',
                'data-dshr-clean-selected': 'true',
                onClick: handlers.cleanUp,
                disabled: busy !== null || selected.size === 0,
              },
              busy === 'clean' ? t('action.cleaning') : t('action.cleanSelected', { count: selected.size }),
            ),
            h('span', { className: 'dshr-muted' }, t('action.cleanNote')),
          )
        : null,
    )
  }

  /**
   * One row.
   *
   * Three shapes, and the difference is the point:
   *
   *   - **safe** — a checkbox, because the batch route really can clear it;
   *   - **confirm** — no checkbox; a "still clean up…" entry that opens an explanation of
   *     what the family-wide action would move and which conditions block the batch route;
   *   - **danger** — a disabled checkbox plus the reason, because the row is not offered
   *     for destruction at all and saying so is more useful than an apology later.
   */
  function renderRow(react, row, tier, context) {
    var h = react.createElement
    var t = context.t
    var facts = row.facts || {}
    var breakdown = row.freedBreakdown || {}
    var blocking = (row.blockingChecks || []).filter(function (check) {
      return check.ok === false
    })

    var title = facts.title !== null && facts.title !== undefined ? facts.title : null
    var relative = formatRelative(facts.lastActivity, context.locale)
    var metrics = [
      t('row.images', { count: row.dedupCount === null || row.dedupCount === undefined ? '?' : row.dedupCount }),
      t('row.size', { size: formatBytes(facts.sizeBytes) }),
      t('row.freed', { size: formatBytes(row.freedByDeletingBytes) }),
      relative === null ? t('row.ageUnknown') : t('row.age', { days: (facts.ageDays === null || facts.ageDays === undefined ? '?' : facts.ageDays.toFixed(1)) }),
      facts.archived === null ? t('row.archiveUnknown') : facts.archived === true ? t('row.archived') : t('row.notArchived'),
      t('row.shared', { count: breakdown.sharedWithRetainedSessionCount || 0 }),
    ]

    var selectable = tier === 'safe' && row.batchClearable === true
    var isOpen = context.reviewOpen.has(row.id)
    var family = context.family
    var displayId = sessionIdOf(row.id) || row.id

    var control
    if (tier === 'danger') {
      control = h('input', {
        type: 'checkbox',
        disabled: true,
        checked: false,
        'aria-label': displayId,
        'data-dshr-selectable': 'false',
        'data-dshr-tier': tier,
      })
    } else if (selectable) {
      control = h('input', {
        type: 'checkbox',
        // Stated explicitly rather than left absent: "this control is usable" is the one
        // property the whole rule turns on, so it is written down instead of implied by
        // the absence of an attribute.
        disabled: false,
        checked: context.selected.has(row.id),
        onChange: function () {
          context.toggle(row.id)
        },
        'aria-label': displayId,
        'data-dshr-selectable': 'true',
        'data-dshr-tier': tier,
      })
    } else {
      control = h(
        'button',
        {
          type: 'button',
          'data-dshr-review': row.id,
          'aria-expanded': isOpen,
          onClick: function () {
            context.toggleReview(row.id)
          },
        },
        isOpen ? t('review.actionClose') : t('review.action'),
      )
    }

    return h(
      'div',
      { key: row.id, className: 'dshr-row' + (tier === 'danger' ? ' dshr-disabled' : ''), 'data-dshr-row': row.id },
      h(
        'div',
        { className: 'dshr-row-head' },
        h('label', { className: 'dshr-checkbox' }, control),
        h('span', { className: 'dshr-row-title' }, title === null ? t('row.untitled') : title),
        h('span', { className: 'dshr-row-time' }, relative === null ? t('row.ageUnknown') : relative),
      ),
      h('div', { className: 'dshr-row-id' }, displayId),
      h(
        'div',
        { className: 'dshr-metrics dshr-muted' },
        metrics.map(function (text, index) {
          return h('span', { key: index }, text)
        }),
      ),
      blocking.length === 0
        ? null
        : h(
            'div',
            { className: 'dshr-reasons' },
            blocking.map(function (check) {
              return h('span', { key: check.code }, '· ' + reasonText(t, check))
            }),
          ),
      isOpen
        ? h(
            'div',
            { className: 'dshr-review', 'data-dshr-review-open': row.id },
            h('div', { className: 'dshr-review-title' }, t('review.blockedBy')),
            h(
              'ul',
              null,
              blocking.map(function (check) {
                return h('li', { key: check.code }, reasonText(t, check))
              }),
            ),
            h('div', { className: 'dshr-muted' }, t('review.whyFamily')),
            h(
              'div',
              { className: 'dshr-muted' },
              t('review.explains', {
                count: 1,
                familyCount: family === null ? 1 : family.memberIds.length,
              }),
            ),
            h(
              'div',
              { className: 'dshr-actions' },
              h(
                'button',
                {
                  type: 'button',
                  'data-dshr-review-confirm': row.id,
                  disabled: context.busy !== null,
                  onClick: function () {
                    context.cleanFamily(row.id, family)
                  },
                },
                t('review.confirm'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: function () {
                    context.toggleReview(row.id)
                  },
                },
                t('review.cancel'),
              ),
            ),
          )
        : null,
    )
  }

  /** The quarantine view: restore (safe) and empty (destructive, walled off). */
  function renderBin(react, trash, handlers, busy, t) {
    var h = react.createElement
    if (trash === null || trash === undefined || trash.ok !== true) {
      return h(
        'div',
        { className: 'dshr-card dshr-error' },
        t('state.binUnreadable', { reason: (trash && trash.reason) || 'unknown' }),
      )
    }
    var batches = trash.batches || []
    if (batches.length === 0) {
      return h('div', { className: 'dshr-card dshr-muted' }, t('state.binEmpty'))
    }
    return h(
      'div',
      { className: 'dshr-card' },
      batches.map(function (batch) {
        var size = formatBytes(batch.bytes || 0)
        var count = batch.entries === null || batch.entries === undefined ? '?' : batch.entries
        return h(
          'div',
          { className: 'dshr-row', key: batch.batchId },
          h(
            'div',
            { className: 'dshr-row-head' },
            h('span', { className: 'dshr-row-id' }, batch.batchId),
            h(
              'span',
              { className: 'dshr-badge ' + (batch.kind === 'ok' ? 'dshr-badge-safe' : 'dshr-badge-confirm') },
              batch.kind,
            ),
            h('span', { className: 'dshr-muted' }, t('bin.items', { count: count, size: size })),
          ),
          batch.kind === 'ok' ? null : h('div', { className: 'dshr-muted' }, batch.reason || ''),
          h(
            'div',
            { className: 'dshr-actions' },
            h(
              'button',
              {
                type: 'button',
                'data-dshr-restore': batch.batchId,
                disabled: busy !== null,
                onClick: function () {
                  handlers.restoreBatch(batch.batchId)
                },
              },
              busy === 'restore:' + batch.batchId ? t('bin.restoring') : t('bin.restore'),
            ),
          ),
          // The destructive action lives in its own visibly distinct zone, so it can never
          // be mistaken for the reversible one above it.
          h(
            'div',
            { className: 'dshr-danger-zone' },
            h('h4', null, t('bin.destroyTitle')),
            h('div', { className: 'dshr-muted' }, t('bin.destroyBody', { count: count, size: size })),
            h(
              'div',
              { className: 'dshr-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshr-destroy',
                  disabled: busy !== null,
                  'data-dshr-destructive': 'true',
                  onClick: function () {
                    handlers.emptyBatch(batch.batchId, count + ' · ' + size)
                  },
                },
                busy === 'purge:' + batch.batchId ? t('bin.destroying') : t('bin.destroy'),
              ),
            ),
          ),
        )
      }),
    )
  }

  /** The section component: state machine only, delegating every render. */
  function createSection(react, ctx, messages) {
    /**
     * A minimal React error boundary.
     *
     * Without it, any exception thrown while rendering the panel leaves a **blank area**
     * with nothing on screen and nothing in the server log — the failure mode this project
     * already hit twice (an ESM bundle that never registered, and a `ctx.locale` read that
     * threw). A boundary turns "the panel is empty" into a sentence that says what broke.
     *
     * It is a class because that is the only way React exposes error boundaries.
     */
    function PanelBoundary(props) {
      // Guarded: `react.Component` is present in every real React build, but the panel must
      // not depend on that being true of whatever object it is handed (the test harness
      // passes a minimal stub). A missing base class degrades to a plain object, which
      // still renders and still catches nothing — better than throwing at construction.
      var Base = typeof react.Component === 'function' ? react.Component : function () {}
      Base.call(this, props)
      this.state = { error: null }
    }
    // Minimal prototype wiring: this bundle cannot rely on class syntax being preserved by
    // anything downstream, and `createElement` accepts a constructor either way.
    var BasePrototype = typeof react.Component === 'function' ? react.Component.prototype : {}
    PanelBoundary.prototype = Object.create(BasePrototype)
    PanelBoundary.prototype.constructor = PanelBoundary
    PanelBoundary.getDerivedStateFromError = function (error) {
      return { error: error }
    }
    PanelBoundary.prototype.render = function () {
      if (this.state.error !== null && this.state.error !== undefined) {
        return react.createElement(
          'div',
          { className: 'dshr-root' },
          react.createElement('div', { className: 'dshr-error', 'data-dshr-crash': 'true' }, 'The panel failed to render.'),
          react.createElement('div', { className: 'dshr-muted' }, String((this.state.error && this.state.error.message) || this.state.error)),
        )
      }
      return this.props.children
    }

    var Inner = function ReclaimSection() {
      var stats = react.useState({ status: 'loading', error: null })
      var state = stats[0]
      var setState = stats[1]
      var thresholdState = react.useState(30)
      var thresholdDays = thresholdState[0]
      var setThresholdDays = thresholdState[1]
      var selection = react.useState(function () {
        return new Set()
      })
      var selected = selection[0]
      var setSelected = selection[1]
      var viewState = react.useState('audit')
      var view = viewState[0]
      var setView = viewState[1]
      var busyState = react.useState(null)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var noticeState = react.useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var reviewState = react.useState(function () {
        return new Set()
      })
      var reviewOpen = reviewState[0]
      var setReviewOpen = reviewState[1]
      var collapsedState = react.useState(function () {
        return new Set()
      })
      var collapsed = collapsedState[0]
      var setCollapsed = collapsedState[1]

      // Re-render when the interface language changes, then resolve the language ONCE and use it for
      // everything: the copy and the relative-time format must not be able to disagree.
      useLocaleRevision(react, ctx)
      var locale = readActiveLocale(ctx)
      var t = createTranslator(ctx, messages, locale)

      function load(nextThreshold) {
        setState(function (previous) {
          return { ...previous, status: previous.report === undefined ? 'loading' : 'refreshing' }
        })
        var threshold = nextThreshold === undefined ? thresholdDays : nextThreshold
        // `rescan=1` on every explicit refresh: the route caches its facts in memory for
        // the life of the process, and a cleanup that did not re-read the disk would
        // describe the world as it was before it.
        return Promise.all([
          api('/api/dsh-reclaim/classify?thresholdDays=' + encodeURIComponent(threshold) + '&rescan=1'),
          api('/api/dsh-reclaim/trash'),
        ]).then(function (both) {
          var classification = both[0]
          var trash = both[1]
          if (classification.body === null || classification.body.ok !== true) {
            setState({
              status: 'error',
              error: (classification.body && classification.body.error) || 'HTTP ' + classification.status,
              report: undefined,
            })
            return
          }
          setState({ status: 'ready', error: null, report: classification.body, trash: trash.body })
          // A selection that no longer matches the graded rows must not survive: the rows
          // are the only thing the cleanup acts on, and a stale id would be a request to
          // delete something the user can no longer see.
          setSelected(new Set())
          setReviewOpen(new Set())
        })
      }

      react.useEffect(
        function () {
          load(thresholdDays)
        },
        [thresholdDays],
      )

      function refresh() {
        load(thresholdDays)
      }

      function toggle(id) {
        setSelected(function (previous) {
          var next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      function toggleReview(id) {
        setReviewOpen(function (previous) {
          var next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      function toggleGroup(key) {
        setCollapsed(function (previous) {
          var next = new Set(previous)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      /** Move N sessions, one request each: a failure on one must not abort the rest. */
      function moveSessions(ids, options) {
        setBusy(options && options.busy !== undefined ? options.busy : 'clean')
        setNotice(null)
        var results = []
        var chain = Promise.resolve()
        ids.forEach(function (sessionId) {
          chain = chain.then(function () {
            return api('/api/dsh-reclaim/delete', {
              method: 'POST',
              body: { sessionId: sessionId, confirm: true },
            }).then(function (result) {
              results.push({ id: sessionId, ok: result.body !== null && result.body.ok === true, body: result.body })
            })
          })
        })
        return chain.then(function () {
          setBusy(null)
          var failed = results.filter(function (entry) {
            return !entry.ok
          })
          setNotice({
            kind: failed.length === 0 ? 'ok' : 'warn',
            text:
              (options && options.note !== undefined ? options.note + ' · ' : '') +
              (failed.length === 0
                ? t('notice.moved', { count: results.length })
                : t('notice.moveFailed', {
                    moved: results.length - failed.length,
                    total: results.length,
                    failures: failed.length,
                  }) +
                  failed
                    .map(function (entry) {
                      return entry.id + ' (' + ((entry.body && entry.body.reason) || t('notice.noReason')) + ')'
                    })
                    .join('; ')),
          })
          return load(thresholdDays)
        })
      }

      /**
       * Which selected ids came from the cache/attachment report rather than the session tiers.
       *
       * Read off the same report the rows were rendered from, so the split can never disagree
       * with what the panel showed. A selected id that is not in here is a session id — that is
       * the default because sessions are what this plugin was built around, and a row kind
       * nobody has taught this function about yet should fall back to the route that re-checks
       * the most, not the one that moves files.
       */
      function clearableIdSet() {
        var out = new Set()
        var tiers = (state.report && state.report.tiers) || {}
        ;['caches', 'attachments'].forEach(function (group) {
          var buckets = tiers[group] || {}
          Object.keys(buckets).forEach(function (tier) {
            ;(buckets[tier] || []).forEach(function (row) {
              out.add(row.id)
            })
          })
        })
        return out
      }

      /**
       * Clear non-session rows.
       *
       * One request for the whole set, because `POST /clear` is all-or-nothing: if any id is
       * refused, nothing moves. That is deliberate on the server side — half of an action the
       * user made as one gesture is the kind of surprise this plugin exists to prevent — so
       * this side must not paper over it by retrying the survivors.
       */
      function clearObjects(ids) {
        setBusy('clear')
        setNotice(null)
        return api('/api/dsh-reclaim/clear', { method: 'POST', body: { ids: ids, confirm: true } }).then(function (result) {
          setBusy(null)
          var body = result.body || {}
          var totals = (body.move && body.move.totals) || {}
          setNotice(
            body.ok === true
              ? {
                  kind: 'ok',
                  text: t('notice.cleared', { count: totals.moved || 0, size: formatBytes(totals.bytes || 0) }),
                }
              : {
                  kind: 'warn',
                  text:
                    t('notice.clearFailed', { reason: body.error || body.reason || t('notice.noReason') }) +
                    (body.refusals || [])
                      .map(function (refusal) {
                        return ' ' + refusal.id + ' (' + (refusal.message || refusal.code || t('notice.noReason')) + ')'
                      })
                      .join(';'),
                },
          )
          return load(thresholdDays)
        })
      }

      function cleanUp() {
        var ids = Array.from(selected)
        if (ids.length === 0) return Promise.resolve()
        var objects = clearableIdSet()
        var objectIds = ids.filter(function (id) {
          return objects.has(id)
        })
        var sessionIds = ids.filter(function (id) {
          return !objects.has(id)
        })
        if (objectIds.length === 0) return moveSessions(sessionIds, {})
        if (sessionIds.length === 0) return clearObjects(objectIds)
        // A mixed selection is one gesture, so it gets one notice. The object route runs first
        // and its outcome is folded into the session run's notice: `moveSessions` writes the
        // notice last, and a notice that mentioned only the sessions would report half of what
        // the user asked for.
        setBusy('clear')
        setNotice(null)
        return api('/api/dsh-reclaim/clear', { method: 'POST', body: { ids: objectIds, confirm: true } }).then(
          function (result) {
            var body = result.body || {}
            var totals = (body.move && body.move.totals) || {}
            return moveSessions(sessionIds, {
              note:
                body.ok === true
                  ? t('notice.cleared', { count: totals.moved || 0, size: formatBytes(totals.bytes || 0) })
                  : t('notice.clearFailed', { reason: body.error || body.reason || t('notice.noReason') }),
            })
          },
        )
      }

      /**
       * Clean up one family through the review entry.
       *
       * The entry exists because the batch route is blocked for these rows. The family
       * moves as a whole — that invariant is not this interface's to relax — so the request
       * set is the family's members, intersected with the rows the report actually graded.
       */
      function cleanFamily(sessionId, family) {
        var ids = family === null ? [sessionId] : family.memberIds.slice()
        var known = new Set()
        var all = ((state.report && state.report.tiers && state.report.tiers.sessions) || {})
        ;['safe', 'confirm', 'danger'].forEach(function (tier) {
          ;(all[tier] || []).forEach(function (row) {
            known.add(row.id)
          })
        })
        var movable = ids.filter(function (id) {
          return known.has(id)
        })
        if (movable.length === 0) movable = [sessionId]
        return moveSessions(movable, { busy: 'clean:' + sessionId })
      }

      function restoreBatch(batchId) {
        setBusy('restore:' + batchId)
        return api('/api/dsh-reclaim/restore', { method: 'POST', body: { batch: batchId, confirm: true } }).then(
          function (result) {
            setBusy(null)
            var body = result.body || {}
            setNotice({
              kind: body.ok === true ? 'ok' : 'warn',
              text:
                body.ok === true
                  ? t('notice.restored', { count: body.restored })
                  : t('notice.restoreIncomplete', {
                      restored: body.restored || 0,
                      blocked: body.blocked || 0,
                      failed: body.failed || 0,
                      reason: body.reason || '',
                    }),
            })
            return load(thresholdDays)
          },
        )
      }

      /** Ask for the numbers first, then confirm — never the other way round. */
      function emptyBatch(batchId, described) {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          var message =
            t('bin.destroyTitle') + '\n\n' + batchId + '\n' + described + '\n\n' + t('bin.destroyBody', { count: described, size: '' })
          if (window.confirm(message) !== true) return Promise.resolve()
        }
        setBusy('purge:' + batchId)
        return api('/api/dsh-reclaim/purge', { method: 'POST', body: { batch: batchId, confirm: true } }).then(
          function (result) {
            setBusy(null)
            var body = result.body || {}
            setNotice({
              kind: body.ok === true ? 'ok' : 'warn',
              text:
                body.ok === true
                  ? t('notice.destroyed', {
                      files: (body.removed && body.removed.files) || 0,
                      size: formatBytes((body.removed && body.removed.bytes) || 0),
                    })
                  : t('notice.destroyFailed', { reason: body.reason || body.error || t('notice.noReason') }),
            })
            return load(thresholdDays)
          },
        )
      }

      return renderPanel(
        react,
        {
          t: t,
          locale: locale,
          status: state.status,
          error: state.error,
          report: state.report === undefined ? null : state.report,
          trash: state.trash === undefined ? null : state.trash,
          thresholdDays: thresholdDays,
          view: view,
          selected: selected,
          busy: busy,
          notice: notice,
          reviewOpen: reviewOpen,
          collapsed: collapsed,
        },
        {
          setThresholdDays: setThresholdDays,
          setView: setView,
          toggle: toggle,
          toggleReview: toggleReview,
          toggleGroup: toggleGroup,
          cleanUp: cleanUp,
          cleanFamily: cleanFamily,
          refresh: refresh,
          restoreBatch: restoreBatch,
          emptyBatch: emptyBatch,
        },
      )
    }

    // The section the slot renders: the boundary wraps the real component, so a render
    // failure is visible text instead of an empty settings pane.
    return function ReclaimSection() {
      return react.createElement(PanelBoundary, null, react.createElement(Inner, null))
    }
  }

  /** The plugin body, as the module loader hands it to the client runtime. */
  function apply(ctx) {
    injectStyles()
    // `react` arrives through the closure (see the factory below), NOT through
    // `ctx.require`: the dynamic client context exposes only `get`, the framework verbs,
    // and the services a plugin declares in `inject`, so `ctx.require` is a property the
    // runtime refuses to hand over. Measured in a real browser: the loader reported
    // `cannot get property "require" without inject` and the settings page showed the
    // plugin as failed.
    var react = plugin.__react
    var messages = plugin.__messages

    // The dictionaries are registered ONCE, at apply time. Registering them from
    // `createTranslator` looked harmless but ran on every render — including inside the
    // navigation `label()` — and the host refuses a second registration of the same
    // namespace and locale, so the panel spent its life logging a warning and falling back.
    if (ctx.locale !== undefined && ctx.locale !== null && typeof ctx.locale.register === 'function') {
      try {
        ctx.effect(
          function () {
            return ctx.locale.register(LOCALE_NS, { zh: messages.PANEL_MESSAGES.zh, en: messages.PANEL_MESSAGES.en })
          },
          'dsh-reclaim: locale dictionaries',
        )
      } catch (cause) {
        // A locale service that refuses the dictionary is not fatal: `t` falls back to the
        // copy bundled in this file, so the panel still renders in Chinese.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[dsh-reclaim] the locale dictionaries could not be registered; using the bundled copy:', cause)
        }
      }
      // One line of evidence, kept on purpose: it is what settled the language defect. Measured in a
      // real host, this read `active="zh" bound(top.reclaimable)="删掉可释放"` while the interface was
      // already in English — proving the namespace resolved fine and the panel was simply reading a
      // different language than the document. If the copy ever looks wrong again, this line says in
      // one glance whether the service and the document agree. It runs once, at apply time.
      try {
        var declaredLanguage = typeof document !== 'undefined' && document.documentElement !== null
          ? document.documentElement.getAttribute('lang')
          : null
        var resolvedLanguage = readActiveLocale(ctx)
        if (typeof console !== 'undefined' && console.info) {
          console.info(
            '[dsh-reclaim] language: document=' +
              JSON.stringify(declaredLanguage) +
              ' resolved=' +
              JSON.stringify(resolvedLanguage),
          )
        }
      } catch (cause) {
        /* logging never affects behaviour */
      }

      // Report the ground this bundle stands on, once.
      //
      // DSH states that compatibility-breaking changes are expected, and its manifest fields are
      // declarative only — nothing enforces them — so a mismatch shows up as a blank settings page
      // rather than as an error. Measured precedent: the panel once registered dictionaries from the
      // wrong scope and rendered nothing legible, and the host reported no error at all. Naming the
      // missing capability turns that into a one-glance diagnosis.
      try {
        var capabilityChecks = [
          {
            capability: 'ctx.slots.inject',
            present: typeof ctx.slots?.inject === 'function',
            neededFor: 'the settings section this panel lives in',
          },
          {
            capability: 'ctx.slots.register',
            present: typeof ctx.slots?.register === 'function',
            neededFor: 'the settings section this panel lives in',
          },
          {
            capability: 'ctx.locale.bind',
            present: typeof ctx.locale?.bind === 'function',
            neededFor: 'host-language copy; without it the panel uses its bundled dictionaries',
          },
          {
            capability: 'ctx.locale.register',
            present: typeof ctx.locale?.register === 'function',
            neededFor: 'offering this panel\'s dictionaries to the host',
          },
          {
            capability: 'ctx.effect',
            present: typeof ctx.effect === 'function',
            neededFor: 'registering and unwinding the section',
          },
        ]
        var missingCapabilities = capabilityChecks
          .filter(function (check) {
            return check.present !== true
          })
          .map(function (check) {
            return check.capability
          })
        if (typeof console !== 'undefined' && console.info) {
          console.info(
            '[dsh-reclaim] capabilities: ' +
              (missingCapabilities.length === 0 ? 'all present' : 'MISSING ' + JSON.stringify(missingCapabilities)),
          )
        }
        plugin.__capabilities = { ok: missingCapabilities.length === 0, missing: missingCapabilities, checks: capabilityChecks }
      } catch (cause) {
        /* probing never affects behaviour */
      }
    }

    // `slots` is declared in `inject`, so `ctx.slots` is available here.
    ctx.effect(
      function () {
        return ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'reclaim',
              order: 60,
              label: function () {
                // The section's own name, in the active language: the host calls this whenever it
                // renders the settings navigation, so it is resolved fresh each time — and from the
                // same source the panel uses, or the navigation and the panel could disagree.
                return createTranslator(ctx, messages, readActiveLocale(ctx))('app.section')
              },
              inject: function () {
                return {}
              },
            },
            createSection(react, ctx, messages),
          )
        })
      },
      'dsh-reclaim: settings section',
    )
  }

  var plugin = { name: 'reclaim-client', inject: ['slots', 'locale'], apply: apply }

  /**
   * The copy dictionaries, INLINED — and that is a measured constraint, not duplication
   * for its own sake.
   *
   * The module loader answers `require()` only for **bare package roots**: its
   * `exactPackageSpecifier` explicitly excludes anything containing a `/` (except the
   * `@scope/name` pair), and the graph is built per package row. So
   * `require('dsh-reclaim/messages')` can never resolve — a bundle that depends on it
   * would fail to materialize and the settings page would be blank with no server-side
   * error. `lib/messages.js` remains the single source of truth; a unit test asserts these
   * literals match it, so drift is caught by `node --test` instead of in someone's browser.
   */
  var INLINE_MESSAGES = {
    PANEL_LOCALES: ['zh', 'en'],
    FALLBACK_LOCALE: 'zh',
    PANEL_MESSAGES: {
      zh: {
        'app.section': '空间回收',
        'top.reclaimable': '删掉可释放',
        'top.quarantine': '隔离区占用（仍在磁盘上）',
        'top.netRelease': '净释放 = 可释放 − 隔离区',
        'top.source': function (p) {
          return '数据来源：' + p.sessions + ' 个会话 · ' + p.attachments + ' 张去重附件 · ' + p.families + ' 个家族 · 扫描代数 ' + p.scan
        },
        'top.pending': function (p) {
          return p.count + ' 项待确认（引用关系未证明完整，孤儿附件判定已暂停）'
        },
        'threshold.group': '阈值',
        'threshold.days': function (p) {
          return p.days + ' 天'
        },
        'threshold.note': '改阈值只重新分档，不重扫',
        'view.audit': '审计',
        'view.bin': '隔离区',
        'view.binWithCount': function (p) {
          return '隔离区（' + p.batches + ' 批 / ' + p.size + '）'
        },
        'action.rescan': '重新扫描',
        'action.rescanning': '重新读取中…',
        'action.cleanSelected': function (p) {
          return '清理所选 ' + p.count + ' 项（进隔离区，可恢复）'
        },
        'action.cleaning': '搬运中…',
        'action.cleanNote': '只会搬进插件自带的隔离区，不会销毁任何东西',
        'state.loading': '正在读取审计结果…',
        'state.loadFailed': function (p) {
          return '审计结果读不到：' + p.error
        },
        'state.retry': '重试',
        'state.binUnreadable': function (p) {
          return '隔离区读不到：' + p.reason
        },
        'state.binEmpty': '隔离区是空的。清理过的会话会出现在这里，可以恢复。',
        'tier.safe': '安全',
        'tier.confirm': '需确认',
        'tier.danger': '危险',
        'tier.count': function (p) {
          return p.count + ' 项'
        },
        'tier.safeEmpty': '没有可批量清理的项：可能是会话都还很新，或归档得不够久',
        'tier.confirmEmpty': '没有需要逐个确认的项',
        'tier.dangerEmpty': '没有不可清理的项',
        'row.images': function (p) {
          return p.count + ' 张图片'
        },
        'row.size': function (p) {
          return '会话 ' + p.size
        },
        'row.freed': function (p) {
          return '删掉可释放 ' + p.size
        },
        'row.age': function (p) {
          return p.days + ' 天未活动'
        },
        'row.ageUnknown': '未活动时间未知',
        'row.archived': '已归档',
        'row.notArchived': '未归档',
        'row.archiveUnknown': '归档状态未知',
        'row.shared': function (p) {
          return '共享未释放 ' + p.count + ' 张'
        },
        'row.untitled': '（无标题）',
        'review.action': '仍要清理…',
        'review.actionClose': '收起',
        'review.explains': function (p) {
          return '这一族共 ' + p.familyCount + ' 个会话，会整族一起搬进隔离区（本次选中 ' + p.count + ' 项）。'
        },
        'review.blockedBy': '被这些条件挡住：',
        'review.whyFamily': '家族要么整族一起动，要么都不动——只删其中一部分会让留下来的会话内容不完整。',
        'review.members': function (p) {
          return '同族成员 ' + p.count + ' 个：'
        },
        'review.confirm': '确认清理这一族',
        'review.cancel': '取消',
        'bin.items': function (p) {
          return p.count + ' 项 · ' + p.size
        },
        'bin.restore': '恢复',
        'bin.restoring': '恢复中…',
        'bin.destroyTitle': '彻底清空（不可恢复）',
        'bin.destroyBody': function (p) {
          return '将永久删除 ' + p.count + ' 项、' + p.size + '。这不进回收站，无法撤销。'
        },
        'bin.destroy': '彻底清空这一批',
        'bin.destroying': '清空中…',
        'notice.moved': function (p) {
          return '已把 ' + p.count + ' 个会话搬进隔离区，可从"隔离区"视图恢复。'
        },
        'notice.moveFailed': function (p) {
          return '搬走 ' + p.moved + '/' + p.total + '；' + p.failures + ' 项失败并留在原位：'
        },
        'notice.noReason': '未给出原因',
        'notice.restored': function (p) {
          return '已恢复 ' + p.count + ' 项。'
        },
        'notice.restoreIncomplete': function (p) {
          return '恢复未完成：成功 ' + p.restored + '、受阻 ' + p.blocked + '、失败 ' + p.failed + '。' + p.reason
        },
        'notice.destroyed': function (p) {
          return '已永久删除 ' + p.files + ' 个文件、' + p.size + '。'
        },
        'notice.destroyFailed': function (p) {
          return '清空失败：' + p.reason
        },
        'notice.reviewFamilyOnly': function (p) {
          return '这个入口按家族处理：本族 ' + p.familyCount + ' 个会话会一起搬进隔离区。'
        },
        'reason.not-archived': '未归档——归档是你亲手表达的"我不需要它了"',
        'reason.too-recent': '未超过阈值',
        'reason.liveness-idle-live': '正在使用中——内存里活着，删掉会让当前对话失去内容',
        'reason.liveness-running': '正在使用中——Agent 正在跑一个回合',
        'reason.liveness-unknown': '活态无法判定，保守起见一律不可清',
        'reason.sessions-service-unavailable': '读不到活态服务，无法证明它不在用',
        'reason.archived-unknown': '归档状态未知，不能当成"未归档"，也不能当成"已归档"',
        'reason.age-unknown': '最后活动时间读不到，年龄未知——未知既不满足"超过阈值"，也不等于很老',
        'reason.referenced-by-retained': '被另一个会话以 @会话引用 指向，删掉会破坏那条引用',
        'reason.parent-of-outside': '是某个保留会话的父会话：删掉它会让子会话的谱系显示不完整',
        'reason.child-not-in-batch': '有子会话不在本批删除范围内',
        'reason.family-dirty': '家族里还有成员不满足安全档条件，整个家族因此不参与批量清',
        'reason.referenced': '仍被保留的会话引用，删掉会损坏那些会话',
        'reason.referenced-by-session': '仍被会话引用：删掉它会让那些会话失去内容',
        'reason.reference-graph-unavailable': '引用图整表读不到，无法证明这个对象零引用',
        'reason.orphan-determination-paused': '有会话的引用关系无法证明完整，孤儿判定整体暂停',
        'reason.graph-unavailable': '引用图整表读不到，无法证明任何附件零引用',
        'reason.unknown-object': '不属于任何已定义族的对象，无法判断它是什么',
        'reason.family-no-entry': '这一族没有安全档条款，只报告、不提供清理',
        'reason.not-enumerated': '目录没能枚举，因此既不说它安全，也不说它有什么',
        'reason.cache-not-enumerated': '这一项没能枚举，因此既不说它安全，也不说它有什么',
        'reason.cache-family-not-enumerated': '这一族没能枚举：没读到内容不等于内容是空的，所以不进安全档',
        'reason.session-listing-unavailable': '核心会话清单读不到，无法确认它不被任何会话占用；缺失的清单不等于空清单',
        'reason.invalid-session-id': '会话 ID 格式无效或包含路径穿越字符，服务端拒绝处理',
        'clear.title': '可重建产物与附件',
        'clear.count': function (p) {
          return p.count + ' 项'
        },
        'clear.note': '清理由服务端按 id 重新推导路径：本面板只送 id，从不指名文件。',
        'clear.kind.cache': '可重建缓存',
        'clear.kind.cache-family': '可重建缓存族',
        'clear.kind.attachment': '附件对象',
        'clear.kind.unknown-object': '未归类对象',
        'clear.kind.report-only-family': '只报告、不清理的族',
        'clear.tier.safe': '安全',
        'clear.tier.confirm': '需确认',
        'clear.tier.danger': '危险',
        'clear.tier.unclassified': '未分类',
        'clear.tier.reportOnly': '只报告',
        'clear.size': function (p) {
          return p.size
        },
        'clear.files': function (p) {
          return p.count + ' 个文件'
        },
        'notice.cleared': function (p) {
          return '已把 ' + p.count + ' 项、' + p.size + ' 搬进隔离区，可从"隔离区"视图恢复。'
        },
        'notice.clearFailed': function (p) {
          return '没有搬运任何东西：' + p.reason
        },
      },
      en: {
        'app.section': 'Space reclaim',
        'top.reclaimable': 'Reclaimable',
        'top.quarantine': 'In quarantine (still on disk)',
        'top.netRelease': 'Net release = reclaimable − quarantine',
        'top.source': function (p) {
          return (
            'Source: ' + p.sessions + ' session' + (p.sessions === 1 ? '' : 's') +
            ' · ' + p.attachments + ' deduplicated attachment' + (p.attachments === 1 ? '' : 's') +
            ' · ' + p.families + ' famil' + (p.families === 1 ? 'y' : 'ies') +
            ' · scan generation ' + p.scan
          )
        },
        'top.pending': function (p) {
          return (
            p.count + ' item' + (p.count === 1 ? '' : 's') +
            ' awaiting confirmation (reference completeness is unproven, so orphan detection is paused)'
          )
        },
        'threshold.group': 'Inactivity window',
        'threshold.days': function (p) {
          return p.days + ' days'
        },
        'threshold.note': 'Changing it re-grades only; it does not rescan',
        'view.audit': 'Audit',
        'view.bin': 'Quarantine',
        'view.binWithCount': function (p) {
          return 'Quarantine (' + p.batches + ' batch' + (p.batches === 1 ? '' : 'es') + ' / ' + p.size + ')'
        },
        'action.rescan': 'Rescan',
        'action.rescanning': 'Rereading…',
        'action.cleanSelected': function (p) {
          return 'Clean up ' + p.count + ' item' + (p.count === 1 ? '' : 's') + ' (moves to quarantine, restorable)'
        },
        'action.cleaning': 'Moving…',
        'action.cleanNote': "It only moves data into the plugin's own quarantine; nothing is destroyed",
        'state.loading': 'Reading the audit…',
        'state.loadFailed': function (p) {
          return 'The audit could not be read: ' + p.error
        },
        'state.retry': 'Try again',
        'state.binUnreadable': function (p) {
          return 'The quarantine could not be read: ' + p.reason
        },
        'state.binEmpty': 'The quarantine is empty. Sessions you clean up appear here, and can be restored.',
        'tier.safe': 'Safe',
        'tier.confirm': 'Needs review',
        'tier.danger': 'Dangerous',
        'tier.count': function (p) {
          return String(p.count)
        },
        'tier.safeEmpty': 'Nothing can be batch-cleared: the sessions are probably still recent, or not archived long enough',
        'tier.confirmEmpty': 'Nothing needs reviewing one by one',
        'tier.dangerEmpty': 'Nothing is un-clearable',
        'row.images': function (p) {
          return p.count + ' image' + (p.count === 1 ? '' : 's')
        },
        'row.size': function (p) {
          return 'session ' + p.size
        },
        'row.freed': function (p) {
          return 'frees ' + p.size
        },
        'row.age': function (p) {
          return p.days + ' days idle'
        },
        'row.ageUnknown': 'idle time unknown',
        'row.archived': 'archived',
        'row.notArchived': 'not archived',
        'row.archiveUnknown': 'archive state unknown',
        'row.shared': function (p) {
          return p.count + ' still shared'
        },
        'row.untitled': '(untitled)',
        'review.action': 'Still clean up…',
        'review.actionClose': 'Hide',
        'review.explains': function (p) {
          return (
            'This family has ' + p.familyCount + ' session' + (p.familyCount === 1 ? '' : 's') +
            ', and moves as a whole (' + p.count + ' selected here).'
          )
        },
        'review.blockedBy': 'Blocked by:',
        'review.whyFamily':
          'A family moves together or not at all — deleting only part of it would leave the remaining sessions incomplete.',
        'review.members': function (p) {
          return p.count + ' member' + (p.count === 1 ? '' : 's') + ' in this family:'
        },
        'review.confirm': 'Clean up this family',
        'review.cancel': 'Cancel',
        'bin.items': function (p) {
          return p.count + ' item' + (p.count === 1 ? '' : 's') + ' · ' + p.size
        },
        'bin.restore': 'Restore',
        'bin.restoring': 'Restoring…',
        'bin.destroyTitle': 'Empty permanently (cannot be undone)',
        'bin.destroyBody': function (p) {
          return (
            'This permanently deletes ' + p.count + ' item' + (p.count === 1 ? '' : 's') + ', ' + p.size +
            '. It does not go to a recycle bin and cannot be undone.'
          )
        },
        'bin.destroy': 'Empty this batch',
        'bin.destroying': 'Emptying…',
        'notice.moved': function (p) {
          return (
            'Moved ' + p.count + ' session' + (p.count === 1 ? '' : 's') +
            ' into the quarantine; restore them from the Quarantine view.'
          )
        },
        'notice.moveFailed': function (p) {
          return 'Moved ' + p.moved + '/' + p.total + '; ' + p.failures + ' failed and stayed in place: '
        },
        'notice.noReason': 'no reason reported',
        'notice.restored': function (p) {
          return 'Restored ' + p.count + ' item' + (p.count === 1 ? '' : 's') + '.'
        },
        'notice.restoreIncomplete': function (p) {
          return (
            'Restore incomplete: restored ' + p.restored + ', blocked ' + p.blocked + ', failed ' + p.failed + '. ' + p.reason
          )
        },
        'notice.destroyed': function (p) {
          return 'Permanently removed ' + p.files + ' file' + (p.files === 1 ? '' : 's') + ', ' + p.size + '.'
        },
        'notice.destroyFailed': function (p) {
          return 'Could not empty the batch: ' + p.reason
        },
        'notice.reviewFamilyOnly': function (p) {
          return (
            'This entry point works per family: all ' + p.familyCount + ' session' + (p.familyCount === 1 ? '' : 's') +
            ' in it move together.'
          )
        },
        'reason.not-archived': 'Not archived — archiving is how you say "I do not need this any more"',
        'reason.too-recent': 'Within the inactivity window',
        'reason.liveness-idle-live': 'In use — loaded in memory; deleting it would empty the conversation you are in',
        'reason.liveness-running': 'In use — the agent is mid-turn',
        'reason.liveness-unknown': 'Liveness could not be determined, so it is treated as unsafe',
        'reason.sessions-service-unavailable': 'The live-session store is unreadable, so "not in use" cannot be proven',
        'reason.archived-unknown': 'Archive state unknown — it is neither "not archived" nor "archived"',
        'reason.age-unknown': 'Last activity is unreadable, so the age is unknown — unknown is not "old"',
        'reason.referenced-by-retained': 'Another session references it with @session; deleting it would break that reference',
        'reason.parent-of-outside': "It is the parent of a session being kept: deleting it would leave that session's lineage incomplete",
        'reason.child-not-in-batch': 'It has child sessions outside this batch',
        'reason.family-dirty': 'Another member of its family is not safe, so the family does not take part in batch cleanup',
        'reason.referenced': 'Still referenced by a session that is being kept; deleting it would damage that session',
        'reason.referenced-by-session': 'Still referenced by a session: removing it would leave that session without its content',
        'reason.reference-graph-unavailable': 'The whole reference graph could not be read, so nothing can be proven unreferenced',
        'reason.orphan-determination-paused': 'Reference completeness is unproven for some session, so orphan detection is paused',
        'reason.graph-unavailable': 'The reference graph is unreadable, so no attachment can be proven unreferenced',
        'reason.unknown-object': 'It belongs to no defined family, so what it is cannot be established',
        'reason.family-no-entry': 'This family has no safe-tier rule; it is reported but not offered for cleanup',
        'reason.not-enumerated': 'The directory could not be enumerated, so it is neither called safe nor described',
        'reason.cache-not-enumerated': 'This item could not be enumerated, so it is neither called safe nor described',
        'reason.cache-family-not-enumerated': 'This family could not be enumerated: not having read the contents is not the same as the contents being empty, so it is not promoted to safe',
        'reason.session-listing-unavailable': 'The core session listing could not be read, so nothing can be proven unowned; a missing listing is not an empty listing',
        'reason.invalid-session-id': 'The session ID is invalid or contains path-traversal characters and was refused',
        'clear.title': 'Rebuildable artifacts and attachments',
        'clear.count': function (p) {
          return p.count + ' item' + (p.count === 1 ? '' : 's')
        },
        'clear.note': 'The server re-derives the paths from the row id: this panel sends ids and never names a file.',
        'clear.kind.cache': 'Rebuildable cache',
        'clear.kind.cache-family': 'Rebuildable cache family',
        'clear.kind.attachment': 'Attachment object',
        'clear.kind.unknown-object': 'Unclassified object',
        'clear.kind.report-only-family': 'Reported, not cleared',
        'clear.tier.safe': 'Safe',
        'clear.tier.confirm': 'Needs confirmation',
        'clear.tier.danger': 'Dangerous',
        'clear.tier.unclassified': 'Unclassified',
        'clear.tier.reportOnly': 'Report only',
        'clear.size': function (p) {
          return p.size
        },
        'clear.files': function (p) {
          return p.count + ' file' + (p.count === 1 ? '' : 's')
        },
        'notice.cleared': function (p) {
          return 'Moved ' + p.count + ' item' + (p.count === 1 ? '' : 's') + ', ' + p.size + ', into the quarantine; restore them from the bin view.'
        },
        'notice.clearFailed': function (p) {
          return 'Nothing was moved: ' + p.reason
        },
      },
    },
  }

  /**
   * Local lookup over the inline dictionaries.
   *
   * This is the fallback path — not a duplicate of a module. It is the reason the panel
   * still renders when the host exposes no locale service at all (A9c), and it is also the
   * reason `createTranslator` never returns a bare key: `t()` prefers the host's answer and
   * otherwise comes here.
   */
  function localTranslate(locale, key, params) {
    var dict = INLINE_MESSAGES.PANEL_MESSAGES[locale] || INLINE_MESSAGES.PANEL_MESSAGES.zh
    var entry = dict[key] !== undefined ? dict[key] : INLINE_MESSAGES.PANEL_MESSAGES.zh[key]
    if (entry === undefined) return key
    if (typeof entry === 'function') return String(entry(params || {}))
    if (params === undefined) return entry
    return entry.replace(/\{(\w+)\}/g, function (match, name) {
      return name in params ? String(params[name]) : match
    })
  }

  plugin.__messages = { PANEL_MESSAGES: INLINE_MESSAGES.PANEL_MESSAGES, translatePanel: localTranslate }

  var hasModuleLoader = typeof window !== 'undefined' && window.__ModuleLoader__ && window.__ModuleLoader__.load

  if (hasModuleLoader) {
    window.__ModuleLoader__.load({
      id: '@was35/dsh-reclaim',
      factory: function (require) {
        // `require` lives HERE and only here, and only for the ONE module the host can
        // resolve: a bare package root. Subpaths are not in the module graph (see
        // INLINE_MESSAGES above), so the panel's own copy is inlined instead.
        plugin.__react = require('react')
        return plugin
      },
    })
  }

  if (typeof globalThis !== 'undefined') {
    // Test seam, and the reason this bundle has a second mode at all: the render function is
    // hook-free, so a plain call can assert every interface rule **without a browser**.
    //
    // It is attached on BOTH paths on purpose. The name is namespaced and nothing in the
    // page reads it; in exchange, a test can evaluate this file exactly once — with a fake
    // module loader, as the browser does — and get the registration AND the seam from the
    // SAME plugin instance. Evaluating twice produced two instances, and tests then failed
    // with `Cannot read properties of undefined (reading 'Component')` depending on call
    // order.
    globalThis.__dshReclaimPanel = { renderPanel: renderPanel, createSection: createSection, plugin: plugin }
  }
})()
