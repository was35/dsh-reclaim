/**
 * dsh-reclaim — the browser half.
 *
 * Registers the plugin's settings section: an audit view where a person can see
 * what is reclaimable, why, and clean it up into a recoverable quarantine.
 *
 * ---------------------------------------------------------------------------
 * ## The bundle shape is not a style choice — it is measured
 * ---------------------------------------------------------------------------
 *
 * The host reads `exports["./client"]` and concatenates it with other plugins'
 * bundles into **classic scripts**, then executes them in the page. So this file
 * must be valid as a classic script:
 *
 *   - **no top-level `export`** — a module-level `export` is a syntax error in a
 *     classic script, and the whole bundle dies with `Unexpected token 'export'`
 *     and a blank settings page. Measured in a real browser: the first version of
 *     this file used ESM exports and the console filled with exactly that error.
 *   - **no `import`** — same reason. External modules arrive through the factory's
 *     `require`.
 *   - the bundle's only load-time act is registering a factory:
 *     `window.__ModuleLoader__.load({ id, factory })`.
 *
 * Everything the host consumes is returned from the factory (or, equivalently,
 * assigned onto a CommonJS-style `exports`), which is what the installed
 * third-party bundles do.
 *
 * ## What this half depends on
 *
 * `react`, obtained from the factory's `require` — verified present in other
 * installed plugins' bundles, so the shell provides it. Nothing else,
 * deliberately: every additional module is another way for the settings page to
 * come up blank with no server-side error to look at.
 *
 * ## The two interface rules that are acceptance criteria, not polish
 *
 *   1. **A dangerous row cannot be selected.** The checkbox is disabled and the
 *      reason is printed next to it. Letting a user tick it and then refusing
 *      would deliver the same information at the worst possible moment.
 *   2. **"Clean up" and "empty permanently" must never look alike.** The first
 *      moves data into the quarantine and is reversible; the second destroys it.
 *      They live in different views, with different colours, and the destructive
 *      one states its numbers and requires an explicit confirmation.
 *
 * A third rule from the design: the top bar reports the live tree, the quarantine
 * and the net release **separately**. A user who clears 50 MB and then sees total
 * usage rise by 50 MB concludes the plugin lied — and they would be right, because
 * a quarantine is not a delete.
 */

;(function () {
  'use strict'

  /**
   * The panel's stylesheet, injected at materialization time.
   *
   * Inline styles would do for a static layout, but a disabled row and a
   * destructive zone need rules, and a `<style>` tag inside the factory is exactly
   * the shape the module loader documents ("every module body side effect,
   * including CSS injection, lives inside the factory closure").
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
    '.dshr-row{display:flex;flex-direction:column;gap:4px;border-top:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.22));padding:8px 0}',
    '.dshr-row-head{display:flex;gap:8px;align-items:baseline}',
    '.dshr-row-id{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}',
    '.dshr-metrics{display:flex;flex-wrap:wrap;gap:10px}',
    '.dshr-reasons{display:flex;flex-direction:column;gap:2px}',
    '.dshr-reasons span{color:var(--dsw-alias-state-warning-primary,#b4771a)}',
    '.dshr-tier{display:flex;flex-direction:column;gap:6px}',
    '.dshr-tier>h4{margin:0;font-size:13px;display:flex;gap:8px;align-items:baseline}',
    '.dshr-badge{border-radius:6px;padding:0 6px;font-size:11px;border:.5px solid currentColor}',
    '.dshr-badge-danger{color:var(--dsw-alias-state-error-primary,#d14343)}',
    '.dshr-badge-confirm{color:var(--dsw-alias-state-warning-primary,#b4771a)}',
    '.dshr-badge-safe{color:var(--dsw-alias-state-success-primary,#2e9e5b)}',
    '.dshr-thresholds{display:flex;gap:6px;align-items:center}',
    '.dshr-thresholds button,.dshr-actions button,.dshr-bin button{border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:transparent;color:inherit;font:inherit;border-radius:6px;padding:4px 10px;cursor:pointer}',
    '.dshr-thresholds button[aria-pressed="true"]{border-color:var(--dsw-alias-state-business-primary,#4b7bec);color:var(--dsw-alias-state-business-primary,#4b7bec)}',
    '.dshr-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}',
    '.dshr-actions .dshr-primary{border-color:var(--dsw-alias-state-business-primary,#4b7bec)}',
    '.dshr-danger-zone{border:.5px solid var(--dsw-alias-state-error-primary,#d14343);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;margin-top:8px}',
    '.dshr-danger-zone h4{margin:0;color:var(--dsw-alias-state-error-primary,#d14343);font-size:13px}',
    '.dshr-danger-zone button.dshr-destroy{border-color:var(--dsw-alias-state-error-primary,#d14343);color:var(--dsw-alias-state-error-primary,#d14343)}',
    '.dshr-disabled{opacity:.55}',
    '.dshr-error{color:var(--dsw-alias-state-error-primary,#d14343)}',
    '.dshr-checkbox{display:flex;align-items:center;gap:6px}',
    '.dshr-scroll{max-height:340px;overflow:auto}',
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

  function tierLabel(tier) {
    if (tier === 'safe') return '安全'
    if (tier === 'confirm') return '需确认'
    return '危险'
  }

  function emptyTierNote(tier) {
    if (tier === 'safe') return '没有可批量清理的项：可能是会话都还很新，或归档得不够久'
    if (tier === 'confirm') return '没有需要逐个确认的项'
    return '没有不可清理的项'
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
   * Render the whole panel from data plus interaction state, with no hooks.
   *
   * Separate from the component on purpose: this function holds every rule that
   * matters to a user — what a row may be selected, where the destructive action
   * lives, how the three byte figures are labelled — and being hook-free means it
   * can be rendered and asserted **without a DOM or a browser**.
   */
  function renderPanel(react, input, handlers) {
    var h = react.createElement
    var status = input.status
    var error = input.error
    var report = input.report
    var trash = input.trash
    var thresholdDays = input.thresholdDays
    var view = input.view
    var selected = input.selected
    var busy = input.busy
    var notice = input.notice

    if (status === 'loading') {
      return h('div', { className: 'dshr-root' }, h('div', { className: 'dshr-muted' }, '正在读取审计结果…'))
    }
    if (status === 'error') {
      return h(
        'div',
        { className: 'dshr-root' },
        h('div', { className: 'dshr-error' }, '审计结果读不到：' + error),
        h('div', { className: 'dshr-actions' }, h('button', { type: 'button', onClick: handlers.refresh }, '重试')),
      )
    }

    // Rows come from `tiers.sessions` — the grouped view the classifier already
    // built. Re-deriving the grouping from the flat list would be a second
    // implementation of the same rule.
    var tiers = (report.tiers && report.tiers.sessions) || {}
    var byTier = { safe: tiers.safe || [], confirm: tiers.confirm || [], danger: tiers.danger || [] }

    var footprint = (trash && trash.footprint) || null
    var quarantineBytes = footprint === null ? 0 : footprint.bytes || 0
    var totals = report.totals || {}
    var reclaimable = totals.totalReclaimableBytes || 0
    // The net release is a subtraction the user can check by hand: what a cleanup
    // would free, minus what it parks in the quarantine.
    var netRelease = reclaimable - quarantineBytes

    function tierRows(tier) {
      return h(
        'div',
        { className: 'dshr-tier' },
        h(
          'h4',
          null,
          h('span', { className: 'dshr-badge dshr-badge-' + tier }, tierLabel(tier)),
          h('span', { className: 'dshr-muted' }, byTier[tier].length + ' 项'),
        ),
        byTier[tier].length === 0
          ? h('div', { className: 'dshr-muted' }, emptyTierNote(tier))
          : h(
              'div',
              { className: 'dshr-scroll' },
              byTier[tier].map(function (row) {
                return renderRow(react, row, tier, selected, handlers.toggle)
              }),
            ),
      )
    }

    var gate = report.gate || {}
    var sourceLine =
      '数据来源：' +
      (totals.sessionCount || 0) + ' 个会话 · ' +
      (totals.dedupAttachmentCount || 0) + ' 张去重附件 · ' +
      ((report.families || []).length) + ' 个家族 · 扫描代数 ' + (report.scanCount === undefined ? '?' : report.scanCount) +
      (gate.orphanDeterminationAllowed === false
        ? ' · ⚠ ' + ((gate.unknownSessions || []).length) + ' 项待确认（引用关系未证明完整，孤儿附件判定已暂停）'
        : '')

    return h(
      'div',
      { className: 'dshr-root' },
      h(
        'div',
        { className: 'dshr-card' },
        h(
          'div',
          { className: 'dshr-top' },
          h('div', null, h('b', null, formatBytes(reclaimable)), h('div', { className: 'dshr-muted' }, '删掉可释放')),
          h(
            'div',
            null,
            h('b', null, formatBytes(quarantineBytes)),
            h('div', { className: 'dshr-muted' }, '隔离区占用（仍在磁盘上）'),
          ),
          h(
            'div',
            null,
            h('b', { className: netRelease >= 0 ? 'dshr-net-pos' : 'dshr-net-neg' }, formatBytes(netRelease)),
            h('div', { className: 'dshr-muted' }, '净释放 = 可释放 − 隔离区'),
          ),
        ),
        h('div', { className: 'dshr-muted' }, sourceLine),
        h(
          'div',
          { className: 'dshr-thresholds', role: 'group', 'aria-label': '阈值' },
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
              days + ' 天',
            )
          }),
          h('span', { className: 'dshr-muted' }, '改阈值只重新分档，不重扫'),
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
          '审计',
        ),
        h(
          'button',
          { type: 'button', 'aria-pressed': view === 'bin', onClick: function () { handlers.setView('bin') } },
          '隔离区' + (footprint === null ? '' : '（' + footprint.batches + ' 批 / ' + formatBytes(quarantineBytes) + '）'),
        ),
        h('span', { style: { flex: 1 } }),
        h(
          'button',
          { type: 'button', onClick: handlers.refresh, disabled: status === 'refreshing' },
          status === 'refreshing' ? '重新读取中…' : '重新扫描',
        ),
      ),

      view === 'audit'
        ? h('div', { className: 'dshr-card' }, tierRows('safe'), tierRows('confirm'), tierRows('danger'))
        : renderBin(react, trash, handlers, busy),

      view === 'audit'
        ? h(
            'div',
            { className: 'dshr-card dshr-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshr-primary',
                onClick: handlers.cleanUp,
                disabled: busy !== null || selected.size === 0,
              },
              busy === 'clean' ? '搬运中…' : '清理所选 ' + selected.size + ' 项（进隔离区，可恢复）',
            ),
            h('span', { className: 'dshr-muted' }, '只会搬进插件自带的隔离区，不会销毁任何东西'),
          )
        : null,
    )
  }

  /** One row. A dangerous row's checkbox is DISABLED, with the reason beside it. */
  function renderRow(react, row, tier, selected, toggle) {
    var h = react.createElement
    var selectable = tier !== 'danger' && row.batchClearable === true
    var facts = row.facts || {}
    var breakdown = row.freedBreakdown || {}
    var reasons = (row.blockingChecks || []).filter(function (check) {
      return check.ok === false
    })

    var metrics = [
      (row.dedupCount === null || row.dedupCount === undefined ? '?' : row.dedupCount) + ' 张图片',
      '会话 ' + formatBytes(facts.sizeBytes),
      '删掉可释放 ' + formatBytes(row.freedByDeletingBytes),
      facts.ageDays === null || facts.ageDays === undefined ? '未活动时间未知' : facts.ageDays.toFixed(1) + ' 天未活动',
      facts.archived === null ? '归档状态未知' : facts.archived === true ? '已归档' : '未归档',
      '共享未释放 ' + (breakdown.sharedWithRetainedSessionCount || 0) + ' 张',
    ]

    return h(
      'div',
      { key: row.id, className: 'dshr-row' + (selectable ? '' : ' dshr-disabled') },
      h(
        'div',
        { className: 'dshr-row-head' },
        h(
          'label',
          { className: 'dshr-checkbox' },
          h('input', {
            type: 'checkbox',
            // `disabled` is the acceptance criterion: the row cannot be selected at
            // all, rather than being selectable and then rejected.
            disabled: !selectable,
            checked: selected.has(row.id),
            onChange: function () {
              toggle(row.id)
            },
            'aria-label': 'select ' + row.id,
            'data-dshr-selectable': selectable ? 'true' : 'false',
            'data-dshr-tier': tier,
          }),
          h('span', { className: 'dshr-row-id' }, row.id),
        ),
      ),
      h(
        'div',
        { className: 'dshr-metrics dshr-muted' },
        metrics.map(function (text, index) {
          return h('span', { key: index }, text)
        }),
      ),
      reasons.length === 0
        ? null
        : h(
            'div',
            { className: 'dshr-reasons' },
            reasons.map(function (check) {
              return h('span', { key: check.code }, '· ' + check.message)
            }),
          ),
    )
  }

  /** The quarantine view: restore (safe) and empty (destructive, walled off). */
  function renderBin(react, trash, handlers, busy) {
    var h = react.createElement
    if (trash === null || trash === undefined || trash.ok !== true) {
      return h(
        'div',
        { className: 'dshr-card dshr-error' },
        '隔离区读不到：' + ((trash && trash.reason) || 'unknown'),
      )
    }
    var batches = trash.batches || []
    if (batches.length === 0) {
      return h('div', { className: 'dshr-card dshr-muted' }, '隔离区是空的。清理过的会话会出现在这里，可以恢复。')
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
            h('span', { className: 'dshr-muted' }, count + ' 项 · ' + size),
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
              busy === 'restore:' + batch.batchId ? '恢复中…' : '恢复',
            ),
          ),
          // The destructive action lives in its own visibly distinct zone, so it can
          // never be mistaken for the reversible one above it.
          h(
            'div',
            { className: 'dshr-danger-zone' },
            h('h4', null, '彻底清空（不可恢复）'),
            h('div', { className: 'dshr-muted' }, '将永久删除 ' + count + ' 项、' + size + '。这不进回收站，无法撤销。'),
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
                    handlers.emptyBatch(batch.batchId, count + ' 项 · ' + size)
                  },
                },
                busy === 'purge:' + batch.batchId ? '清空中…' : '彻底清空这一批',
              ),
            ),
          ),
        )
      }),
    )
  }

  /** The section component: state machine only, delegating every render. */
  function createSection(react, ctx) {
    return function ReclaimSection() {
      var stateHook = react.useState({ status: 'loading', error: null })
      var state = stateHook[0]
      var setState = stateHook[1]
      var thresholdHook = react.useState(30)
      var thresholdDays = thresholdHook[0]
      var setThresholdDays = thresholdHook[1]
      var selectedHook = react.useState(function () {
        return new Set()
      })
      var selected = selectedHook[0]
      var setSelected = selectedHook[1]
      var viewHook = react.useState('audit')
      var view = viewHook[0]
      var setView = viewHook[1]
      var busyHook = react.useState(null)
      var busy = busyHook[0]
      var setBusy = busyHook[1]
      var noticeHook = react.useState(null)
      var notice = noticeHook[0]
      var setNotice = noticeHook[1]

      function load(nextThreshold) {
        setState(function (previous) {
          return { ...previous, status: previous.report === undefined ? 'loading' : 'refreshing' }
        })
        var threshold = nextThreshold === undefined ? thresholdDays : nextThreshold
        // `rescan=1` on every explicit refresh: the route caches its facts in
        // memory for the life of the process, and a cleanup that did not re-read
        // the disk would describe the world as it was before it.
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
          // A selection that no longer matches the graded rows must not survive:
          // the rows are the only thing the cleanup acts on, and a stale id would
          // be a request to delete something the user can no longer see.
          setSelected(new Set())
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

      function cleanUp() {
        var ids = Array.from(selected)
        if (ids.length === 0) return
        setBusy('clean')
        setNotice(null)
        var results = []
        // One request per session: each is an independent move, and a failure on
        // one must not abort the rest of the batch.
        var chain = Promise.resolve()
        ids.forEach(function (sessionId) {
          chain = chain.then(function () {
            return api('/api/dsh-reclaim/delete', { method: 'POST', body: { sessionId: sessionId, confirm: true } }).then(
              function (result) {
                results.push({ id: sessionId, ok: result.body !== null && result.body.ok === true, body: result.body })
              },
            )
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
              failed.length === 0
                ? '已把 ' + results.length + ' 个会话搬进隔离区，可从"隔离区"视图恢复。'
                : '搬走 ' + (results.length - failed.length) + '/' + results.length + '；' + failed.length +
                  ' 项失败并留在原位：' +
                  failed
                    .map(function (entry) {
                      return entry.id + '（' + ((entry.body && entry.body.reason) || '未给出原因') + '）'
                    })
                    .join('；'),
          })
          return load(thresholdDays)
        })
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
                  ? '已恢复 ' + body.restored + ' 项。'
                  : '恢复未完成：成功 ' + (body.restored || 0) + '、受阻 ' + (body.blocked || 0) + '、失败 ' +
                    (body.failed || 0) + '。' + (body.reason || ''),
            })
            return load(thresholdDays)
          },
        )
      }

      /** Ask for the numbers first, then confirm — never the other way round. */
      function emptyBatch(batchId, described) {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          var message =
            '确定要永久删除这一批隔离区内容吗？\n\n' + batchId + '\n' + described +
            '\n\n此操作无法撤销。"清理所选"只是搬进隔离区，这个是真的删除。'
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
                  ? '已永久删除 ' + ((body.removed && body.removed.files) || 0) + ' 个文件、' +
                    formatBytes((body.removed && body.removed.bytes) || 0) + '。'
                  : '清空失败：' + (body.reason || body.error || '未给出原因'),
            })
            return load(thresholdDays)
          },
        )
      }

      return renderPanel(
        react,
        {
          status: state.status,
          error: state.error,
          report: state.report === undefined ? null : state.report,
          trash: state.trash === undefined ? null : state.trash,
          thresholdDays: thresholdDays,
          view: view,
          selected: selected,
          busy: busy,
          notice: notice,
        },
        {
          setThresholdDays: setThresholdDays,
          setView: setView,
          toggle: toggle,
          cleanUp: cleanUp,
          refresh: refresh,
          restoreBatch: restoreBatch,
          emptyBatch: emptyBatch,
        },
      )
    }
  }

  /** The plugin body, as the module loader hands it to the client runtime. */
  function apply(ctx) {
    injectStyles()
    // `react` arrives through the closure (see the factory below), NOT through
    // `ctx.require`: the dynamic client context exposes only `get`, the framework
    // verbs, and the services a plugin declares in `inject`, so `ctx.require` is
    // a property the runtime refuses to hand over. Measured in a real browser: the
    // loader reported `cannot get property "require" without inject` and the
    // settings page showed the plugin as failed.
    var react = plugin.__react
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
                return '空间回收'
              },
              inject: function () {
                return {}
              },
            },
            createSection(react, ctx),
          )
        })
      },
      'dsh-reclaim: settings section',
    )
  }

  var plugin = { name: 'reclaim-client', inject: ['slots'], apply: apply }

  var hasModuleLoader = typeof window !== 'undefined' && window.__ModuleLoader__ && window.__ModuleLoader__.load

  if (hasModuleLoader) {
    window.__ModuleLoader__.load({
      id: 'dsh-reclaim',
      factory: function (require) {
        // `require` lives HERE and only here. The factory is the module system's own
        // scope, so the one external module this panel needs is resolved once and
        // captured in the closure; `apply` never touches it.
        plugin.__react = require('react')
        return plugin
      },
    })
  } else if (typeof globalThis !== 'undefined') {
    // Node-only entry point, and the ONLY reason this file has two modes.
    //
    // The panel is meant to be tested without a browser: the render function is
    // hook-free, so a plain call can assert every interface rule. That would otherwise
    // force a global test seam onto the page as well, so the seam is gated on the
    // module loader's absence — in the browser this branch never runs and nothing is
    // attached to the page's globals.
    globalThis.__dshReclaimPanel = { renderPanel: renderPanel, createSection: createSection, plugin: plugin }
  }
})()
