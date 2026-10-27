/* dsh-tavern-image-dock 浏览器半边。
 *
 * 在右侧栏加一页「生图」：把这一局画过的图挂在侧边栏里，正文滚过去也一直看得见。
 *
 * 图片来源（两路都试，任何一路取不到都不影响另一路）：
 *   1. 配图插件 dsh-tavern-image 自己开的取图地址
 *        GET /plugins/dsh-tavern-image/history        → { jobs: [...] }，每项带 gameId / turn / state / hasImage
 *        GET /plugins/dsh-tavern-image/jobs?id=…&image=1 → 图片本身
 *      这两个地址是该插件给自己的画廊用的，所以这里只当作「读图来源」，不依赖它的内部文件。
 *   2. Tavern 自带生图：tavernUi.listIllustrations()（接口第 4 版），只读，url 可直接当 <img src>。
 *
 * 刷新节奏：这一局每写完一轮（watchTurnState 变化）后的两分钟里每 3 秒刷一次，
 * 还有作业在跑时同样保持 3 秒；否则 20 秒一次；页面在后台时停手。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tavern-image-dock',
  factory: (require) => {
    let React = null
    try {
      React = require('react')
    } catch (error) {
      try { console.warn('[dsh-tavern-image-dock] React 不可用，面板已禁用:', error?.message) } catch {}
      return { name: 'dsh-tavern-image-dock', inject: [], apply() {} }
    }

    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** 配图插件的地址前缀。换用别的配图插件时只改这一行。 */
    const IMAGE_PLUGIN = '/plugins/dsh-tavern-image'
    const HISTORY_URL = IMAGE_PLUGIN + '/history'
    const imageUrl = (jobId) => IMAGE_PLUGIN + '/jobs?id=' + encodeURIComponent(String(jobId)) + '&image=1'

    const ACTIVE_WINDOW_MS = 120000   // 一轮刚写完的两分钟里勤快些：出图通常在结算之后才开始
    const ACTIVE_POLL_MS = 3000
    const IDLE_POLL_MS = 20000
    const MAX_ITEMS = 120
    const RUNNING_STATES = ['pending', 'running', 'uncertain']

    // 玩家手动关掉的卡住作业、大图的显示方式，都记在这台浏览器里
    const HIDDEN_KEY = 'dsh-tavern-image-dock:hidden'
    const FIT_KEY = 'dsh-tavern-image-dock:fit'

    // 配图插件给的作业标签带工程味，翻成人话
    const JOB_LABELS = { 'agent 规划': '自动配图', '单图重绘': '重绘', '历史图片': '旧图' }

    function readList(key) {
      try {
        const value = JSON.parse(window.localStorage.getItem(key) || '[]')
        return Array.isArray(value) ? value.map((item) => String(item)) : []
      } catch {
        return []
      }
    }

    function writeList(key, list) {
      try { window.localStorage.setItem(key, JSON.stringify(list)) } catch {}
    }

    function readFit() {
      try { return window.localStorage.getItem(FIT_KEY) === 'whole' ? 'whole' : 'width' } catch { return 'width' }
    }

    function writeFit(value) {
      try { window.localStorage.setItem(FIT_KEY, value) } catch {}
    }

    let tavernUiService = null

    // ---------- 取图 ----------

    async function fetchPluginJobs() {
      const response = await fetch(HISTORY_URL, { cache: 'no-store' })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const payload = await response.json().catch(() => null)
      const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : []
      if (payload && payload.ok === false) throw new Error(String(payload.error || '配图插件返回失败'))
      return jobs
    }

    async function fetchNativeIllustrations(gameId) {
      const ui = tavernUiService
      if (!ui || typeof ui.listIllustrations !== 'function') return []
      const list = await ui.listIllustrations()
      return (Array.isArray(list) ? list : [])
        .filter((item) => item && item.url && String(item.gameId || '') === gameId)
        .map((item) => ({
          url: String(item.url),
          turn: Number(item.turn) || 0,
          caption: String(item.description || '').trim(),
          createdAt: Number(item.createdAt) || 0,
          source: 'native',
        }))
    }

    function jobToItem(job) {
      const id = String(job.id || '')
      if (!id) return null
      const label = String(job.label || '').trim()
      return {
        key: 'job:' + id,
        jobId: id,
        url: imageUrl(id),
        turn: Number(job.turn) || 0,
        caption: JOB_LABELS[label] || label || '配图',
        size: String(job.size || ''),
        createdAt: Number(job.completedAt || job.createdAt) || 0,
        source: 'plugin',
      }
    }

    function mergeItems(pluginItems, nativeItems) {
      const seen = new Set()
      const merged = []
      for (const item of [...pluginItems, ...nativeItems]) {
        if (!item || !item.url || seen.has(item.url)) continue
        seen.add(item.url)
        merged.push(item)
      }
      // 轮次新的在前；同一轮里后画的在前
      merged.sort((left, right) => (right.turn - left.turn) || (right.createdAt - left.createdAt))
      return merged.slice(0, MAX_ITEMS)
    }

    async function collect(gameId) {
      let jobs = []
      let jobsError = ''
      try {
        jobs = await fetchPluginJobs()
      } catch (error) {
        jobsError = String(error?.message || error)
      }

      let nativeItems = []
      try {
        nativeItems = await fetchNativeIllustrations(gameId)
      } catch (error) {
        nativeItems = []
      }

      const mine = jobs.filter((job) => job && String(job.gameId || '') === gameId)
      const ready = mine.filter((job) => job.state === 'done' && job.hasImage)
      const running = mine.filter((job) => RUNNING_STATES.includes(String(job.state || '')))

      return {
        items: mergeItems(ready.map(jobToItem).filter(Boolean), nativeItems),
        running: running.map((job) => ({
          key: String(job.id || ''),
          turn: Number(job.turn) || 0,
          percent: Math.max(0, Math.min(100, Math.round(Number(job.percent) || 0))),
          state: String(job.state || ''),
        })),
        note: jobsError ? '没读到配图插件的图库：' + jobsError : '',
      }
    }

    // ---------- 样式 ----------

    function pillStyle(active) {
      return {
        appearance: 'none',
        border: '1px solid ' + (active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'),
        background: active ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)' : 'transparent',
        color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
        borderRadius: '999px',
        padding: '3px 9px',
        fontSize: '11px',
        lineHeight: 1.5,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }
    }

    const mutedText = { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 }

    /** 面板工具条上的大按钮：primary 是「画一张」，另一个是「一键生成 PNG」。 */
    function actionButtonStyle(primary, disabled) {
      return {
        flex: '1 1 0',
        minWidth: 0,
        padding: '6px 8px',
        borderRadius: '9px',
        border: '1px solid ' + (primary ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'),
        background: primary ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)' : 'var(--dsw-specific-input-major)',
        color: primary ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
        fontFamily: 'inherit',
        fontSize: '12px',
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }
    }

    function captionOf(item) {
      if (!item) return ''
      const prefix = item.turn ? '第 ' + item.turn + ' 轮' : ''
      return prefix + (item.caption ? (prefix ? ' · ' : '') + item.caption : '')
    }

    function timeOf(item) {
      const at = Number(item?.createdAt)
      if (!at) return ''
      const date = new Date(at)
      const sameDay = date.toDateString() === new Date().toDateString()
      return sameDay
        ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
    }

    // ---------- 画图 ----------

    /**
     * 直接用 <img src> 取图；万一那条地址在图片请求上被拦（缩略图可能不带页面凭据），
     * 就退一步用 fetch 取回字节自己转 blob 地址 —— fetch 和配图插件自己的界面走同一条路，一定带凭据。
     */
    const blobCache = new Map()

    function rememberBlob(url, blobUrl) {
      blobCache.set(url, blobUrl)
      if (blobCache.size > 40) {
        const oldest = blobCache.keys().next().value
        const dropped = blobCache.get(oldest)
        blobCache.delete(oldest)
        try { URL.revokeObjectURL(dropped) } catch {}
      }
    }

    function DockImage({ src, alt, style, eager }) {
      const [blobUrl, setBlobUrl] = useState('')
      useEffect(() => { setBlobUrl('') }, [src])

      const handleError = () => {
        if (blobUrl) return
        const cached = blobCache.get(src)
        if (cached) { setBlobUrl(cached); return }
        fetch(src, { cache: 'no-store' })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.blob()
          })
          .then((blob) => {
            const next = URL.createObjectURL(blob)
            rememberBlob(src, next)
            setBlobUrl(next)
          })
          .catch(() => {})
      }

      return h('img', {
        src: blobUrl || src,
        alt: alt || '',
        onError: handleError,
        loading: eager ? 'eager' : 'lazy',
        decoding: 'async',
        draggable: false,
        style,
      })
    }

    // ---------- 面板 ----------

    function DockPanel({ gameId }) {
      const id = String(gameId || '')
      const [snapshot, setSnapshot] = useState({ items: [], running: [], note: '' })
      const [loading, setLoading] = useState(true)
      const [pinned, setPinned] = useState('')
      const [viewerIndex, setViewerIndex] = useState(-1)
      // 手动关掉的卡住作业：只在这台浏览器里记着，不碰配图插件那边
      const [hidden, setHidden] = useState(() => readList(HIDDEN_KEY))
      // 大图怎么放：width = 按侧栏宽度铺满（默认），whole = 整张缩进一屏
      const [fit, setFit] = useState(readFit)
      // 导出 PNG：正在写盘时锁住按钮，写完留一句结果
      const [exporting, setExporting] = useState(false)
      const [exportNote, setExportNote] = useState('')
      // 手动生图：这一局的轮次状态 + 提交结果
      const [turnState, setTurnState] = useState(null)
      const [drawing, setDrawing] = useState(false)
      const [drawNote, setDrawNote] = useState('')

      const loadRef = useRef(null)

      useEffect(() => {
        setPinned('')
        setViewerIndex(-1)
      }, [id])

      useEffect(() => {
        if (!id) {
          setSnapshot({ items: [], running: [], note: '' })
          setLoading(false)
          loadRef.current = null
          return undefined
        }

        let alive = true
        let inFlight = false
        let timer = null
        let activeUntil = Date.now() + ACTIVE_WINDOW_MS

        const run = async () => {
          if (!alive || inFlight) return
          inFlight = true
          try {
            const next = await collect(id)
            if (!alive) return
            setSnapshot(next)
            setLoading(false)
            // 还有作业在跑就继续勤快刷新，进度条才跟得上
            if (next.running.length) activeUntil = Date.now() + ACTIVE_WINDOW_MS
          } catch (error) {
            if (!alive) return
            setSnapshot((current) => ({ ...current, note: String(error?.message || error) }))
            setLoading(false)
          } finally {
            inFlight = false
          }
        }

        const loop = async () => {
          if (!alive) return
          if (!document.hidden) await run()
          if (!alive) return
          timer = setTimeout(loop, Date.now() < activeUntil ? ACTIVE_POLL_MS : IDLE_POLL_MS)
        }

        loadRef.current = () => {
          activeUntil = Date.now() + ACTIVE_WINDOW_MS
          return run()
        }

        void run()
        timer = setTimeout(loop, ACTIVE_POLL_MS)

        let stopTurn = null
        if (tavernUiService && typeof tavernUiService.watchTurnState === 'function') {
          try {
            stopTurn = tavernUiService.watchTurnState(id, (state) => {
              activeUntil = Date.now() + ACTIVE_WINDOW_MS
              setTurnState(state || null)
            })
          } catch (error) {
            stopTurn = null
          }
        }

        const onVisible = () => {
          if (document.hidden) return
          activeUntil = Date.now() + ACTIVE_WINDOW_MS
          void run()
        }
        document.addEventListener('visibilitychange', onVisible)

        return () => {
          alive = false
          loadRef.current = null
          if (timer) clearTimeout(timer)
          if (typeof stopTurn === 'function') {
            try { stopTurn() } catch {}
          }
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [id])

      const items = snapshot.items
      const hiddenSet = useMemo(() => new Set(hidden), [hidden])
      const runningJobs = snapshot.running.filter((job) => !hiddenSet.has(job.key))
      const hiddenRunning = snapshot.running.length - runningJobs.length

      const current = useMemo(() => {
        if (!items.length) return null
        if (pinned) {
          const found = items.find((item) => item.key === pinned)
          if (found) return found
        }
        return items[0]
      }, [items, pinned])
      const currentIndex = current ? items.findIndex((item) => item.key === current.key) : -1

      const viewing = viewerIndex >= 0 && viewerIndex < items.length ? items[viewerIndex] : null

      const stepViewer = useCallback((delta) => {
        setViewerIndex((index) => {
          if (index < 0) return index
          return Math.max(0, Math.min(items.length - 1, index + delta))
        })
      }, [items.length])

      const hideRunning = useCallback((key) => {
        setHidden((previous) => {
          if (previous.includes(key)) return previous
          const next = [...previous, key].slice(-80)
          writeList(HIDDEN_KEY, next)
          return next
        })
      }, [])

      const restoreHidden = useCallback(() => {
        setHidden([])
        writeList(HIDDEN_KEY, [])
      }, [])

      const toggleFit = useCallback(() => {
        setFit((previous) => {
          const next = previous === 'whole' ? 'width' : 'whole'
          writeFit(next)
          return next
        })
      }, [])

      // 存 PNG：宿主侧直接读配图插件的原图写盘，文件名是「第15轮_20261026-0341_作业号前8位.png」
      const runExport = useCallback(async (list) => {
        if (exporting) return
        const picked = (Array.isArray(list) ? list : []).filter((item) => item && item.jobId)
        if (!picked.length) {
          setExportNote('这一批里没有能存的原图：Tavern 自带生图的图不在配图插件的缓存里')
          return
        }
        setExporting(true)
        setExportNote('')
        try {
          const result = await tavernUiService.callHost('dsh-tavern-image-dock/export', {
            gameId: id,
            entries: picked.map((item) => ({ jobId: item.jobId, turn: item.turn, createdAt: item.createdAt })),
          })
          const parts = ['已存 ' + (Number(result?.written) || 0) + ' 张 PNG']
          if (Number(result?.skipped)) parts.push('已存在 ' + Number(result.skipped) + ' 张')
          const failed = Array.isArray(result?.failed) ? result.failed : []
          if (failed.length) parts.push('失败 ' + failed.length + ' 张：' + (failed[0]?.reason || '原因不明'))
          setExportNote(parts.join('，') + ' → ' + String(result?.dir || ''))
        } catch (error) {
          const message = String(error?.message || error)
          setExportNote(
            String(error?.code || '') === 'TAVERN_PLUGIN_NOT_FOUND'
              ? '导出要靠插件宿主侧：改了宿主代码要先重启一次 DSH 才能用'
              : '导出失败：' + message,
          )
        } finally {
          setExporting(false)
        }
      }, [exporting, id])

      // 手动生图：给当前这一轮补一张。走配图插件自己的 /attach-turn，和正文插图卡上的「配图」同一条路。
      const drawTurn = Number(turnState?.turn) || 0
      const drawBusy = Boolean(turnState && turnState.busy)
      const drawBlocked = !id || !drawTurn || drawBusy

      const runDraw = useCallback(async () => {
        if (drawing) return
        if (!id || !drawTurn) { setDrawNote('还没有可画的轮次'); return }
        if (drawBusy) { setDrawNote('这一轮还在写正文或结算，等它写完再画'); return }
        setDrawing(true)
        setDrawNote('')
        try {
          const payload = await requestDraw(id, drawTurn)
          if (payload === null) return
          const attached = Number(payload?.attached) || 0
          const warnings = Array.isArray(payload?.warnings) ? payload.warnings.filter(Boolean) : []
          if (attached > 0) {
            setDrawNote('已提交 ' + attached + ' 张，出图后自己出现在这里' + (warnings.length ? '（' + warnings.join('；') + '）' : ''))
            void loadRef.current?.()
          } else if (payload?.skipped) {
            setDrawNote('这一轮没画：' + String(payload.reason || '没有合适的画面'))
          } else {
            setDrawNote('没出画面：' + String(payload.error || '规划没有产出画面'))
          }
        } catch (error) {
          setDrawNote('画不了：' + String(error?.message || error))
        } finally {
          setDrawing(false)
        }
      }, [drawBusy, drawing, drawTurn, id])

      const header = h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '10px 12px 8px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
          flex: '0 0 auto',
        },
      },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontSize: '13px', fontWeight: 600, lineHeight: 1.4 } }, '生图'),
          h('div', { style: { ...mutedText, marginTop: '1px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
            items.length
              ? items.length + ' 张 · 最新第 ' + (items[0].turn || '?') + ' 轮'
              : (loading ? '正在读取…' : '这一局还没有图')),
        ),
        items.length
          ? h('button', {
            type: 'button',
            style: pillStyle(!pinned),
            title: pinned ? '回到最新一张' : '一直显示最新一张',
            onClick: () => setPinned(''),
          }, pinned ? '回到最新' : '跟随最新')
          : null,
        h('button', {
          type: 'button',
          style: pillStyle(false),
          title: '重新读一次图库',
          onClick: () => { void loadRef.current?.() },
        }, '↻'),
      )

      // 常驻工具条：手动画一轮 / 一键存 PNG
      const actionBar = h('div', {
        style: {
          display: 'flex',
          gap: '6px',
          padding: '8px 12px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
          flex: '0 0 auto',
        },
      },
        h('button', {
          type: 'button',
          disabled: drawing || drawBlocked,
          title: drawTurn
            ? '让配图插件为第 ' + drawTurn + ' 轮再画一张'
            : '等这一轮写完、结算完才可以画',
          onClick: () => { void runDraw() },
          style: actionButtonStyle(!drawBlocked, drawing || drawBlocked),
        }, drawing ? '提交中…' : (drawTurn ? '画一张（第 ' + drawTurn + ' 轮）' : '画一张')),
        h('button', {
          type: 'button',
          disabled: exporting || !items.length,
          title: '把这一局的图全部存成 PNG（默认 .dsh\\dsh-tavern-images）',
          onClick: () => { void runExport(items) },
          style: actionButtonStyle(false, exporting || !items.length),
        }, exporting ? '导出中…' : '一键生成 PNG'),
      )

      const emptyBlock = !items.length
        ? h('div', {
          style: {
            marginTop: '10px',
            padding: '14px 12px',
            borderRadius: '10px',
            border: '1px dashed var(--dsw-alias-border-l1)',
            background: 'var(--dsw-specific-input-major)',
            ...mutedText,
          },
        },
          loading
            ? '正在读取这一局的图…'
            : (id
              ? '这一局还没画过图。配图插件画完一张，这里就会自己出现，正文滚走也不影响。'
              : '先从侧栏打开一局游戏，这里会显示那一局的图。'),
          snapshot.note
            ? h('div', { style: { marginTop: '8px', color: 'var(--dsw-alias-state-warn-primary)' } }, snapshot.note)
            : null,
        )
        : null

      // 默认按侧栏宽度铺满：竖图就是整条侧栏那么宽，多高都完整显示（整栏可上下滚）
      const heroImageStyle = fit === 'whole'
        ? { display: 'block', width: '100%', height: 'auto', maxHeight: '72vh', objectFit: 'contain' }
        : { display: 'block', width: '100%', height: 'auto' }

      const heroBlock = current
        ? h('div', { style: { marginTop: '10px' } },
          h('div', {
            style: {
              position: 'relative',
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-specific-input-major)',
              borderRadius: '10px',
              overflow: 'hidden',
              lineHeight: 0,
            },
          },
            h(DockImage, {
              src: current.url,
              alt: current.caption || '插图',
              eager: true,
              style: heroImageStyle,
            }),
            h('button', {
              type: 'button',
              'aria-label': '看大图',
              title: '看大图（← → 翻页，Esc 关闭）',
              onClick: () => setViewerIndex(currentIndex),
              style: {
                position: 'absolute',
                inset: 0,
                padding: 0,
                border: 'none',
                background: 'transparent',
                cursor: 'zoom-in',
              },
            }),
            current.turn
              ? h('span', {
                style: {
                  position: 'absolute',
                  top: '6px',
                  left: '6px',
                  padding: '1px 7px',
                  borderRadius: '999px',
                  background: 'rgba(0,0,0,.55)',
                  color: '#fff',
                  fontSize: '10px',
                  lineHeight: 1.6,
                },
              }, '第 ' + current.turn + ' 轮')
              : null,
            h('button', {
              type: 'button',
              onClick: toggleFit,
              title: fit === 'whole' ? '现在整张放进一屏，点一下改成铺满侧栏' : '现在铺满侧栏，点一下改成整张放进一屏',
              style: {
                position: 'absolute',
                top: '6px',
                right: '6px',
                padding: '1px 8px',
                borderRadius: '999px',
                border: 'none',
                background: 'rgba(0,0,0,.55)',
                color: '#fff',
                fontSize: '10px',
                lineHeight: 1.8,
                fontFamily: 'inherit',
                cursor: 'pointer',
              },
            }, fit === 'whole' ? '完整' : '铺满'),
          ),
          h('div', { style: { ...mutedText, marginTop: '6px', display: 'flex', gap: '6px', alignItems: 'baseline' } },
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)', flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              current.caption || (current.source === 'native' ? 'Tavern 自带生图' : '配图插件')),
            current.size ? h('span', { style: { flex: '0 0 auto' } }, current.size) : null,
            timeOf(current) ? h('span', { style: { flex: '0 0 auto' } }, timeOf(current)) : null,
            current.jobId
              ? h('button', {
                type: 'button',
                disabled: exporting,
                title: '把这张原图存成 PNG（默认 .dsh\\dsh-tavern-images）',
                onClick: () => { void runExport([current]) },
                style: {
                  flex: '0 0 auto',
                  padding: '0 7px',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  borderRadius: '999px',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontFamily: 'inherit',
                  fontSize: '10px',
                  lineHeight: '1.8',
                  cursor: exporting ? 'default' : 'pointer',
                  opacity: exporting ? 0.5 : 1,
                },
              }, '存成 PNG')
              : null,
          ),
        )
        : null

      const runningBlock = (runningJobs.length || hiddenRunning)
        ? h('div', { style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' } },
          runningJobs.map((job) => h('div', {
            key: 'running:' + job.key,
            style: {
              padding: '7px 10px',
              borderRadius: '9px',
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-specific-input-major)',
              ...mutedText,
            },
          },
            h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
              h('span', { style: { flex: 1, color: 'var(--dsw-alias-label-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                (job.state === 'pending' ? '排队中' : job.state === 'uncertain' ? '等平台确认' : '正在画')
                + (job.turn ? '第 ' + job.turn + ' 轮' : '')
                + (job.percent ? ' · ' + job.percent + '%' : ' · 等待出图')),
              h('button', {
                type: 'button',
                title: '这个作业不再显示（只在这里隐藏，配图插件那边不动）',
                onClick: () => hideRunning(job.key),
                style: {
                  flex: '0 0 auto',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-tertiary)',
                  fontFamily: 'inherit',
                  fontSize: '13px',
                  lineHeight: 1,
                  padding: '0 2px',
                  cursor: 'pointer',
                },
              }, '×'),
            ),
            h('div', {
              style: {
                marginTop: '5px',
                height: '3px',
                borderRadius: '999px',
                background: 'color-mix(in srgb, var(--dsw-alias-label-tertiary) 22%, transparent)',
                overflow: 'hidden',
              },
            }, h('div', {
              style: {
                width: Math.max(4, job.percent) + '%',
                height: '100%',
                background: 'var(--dsw-alias-brand-primary)',
                transition: 'width .4s ease',
              },
            })),
          )),
          hiddenRunning
            ? h('button', {
              type: 'button',
              onClick: restoreHidden,
              style: {
                alignSelf: 'flex-start',
                padding: 0,
                border: 'none',
                background: 'transparent',
                fontFamily: 'inherit',
                fontSize: '11px',
                color: 'var(--dsw-alias-label-tertiary)',
                textDecoration: 'underline',
                cursor: 'pointer',
              },
            }, '已隐藏 ' + hiddenRunning + ' 个卡住的作业 · 恢复显示')
            : null,
        )
        : null

      const stripBlock = items.length > 1
        ? h('div', {
          style: {
            marginTop: '12px',
            display: 'flex',
            gap: '6px',
            overflowX: 'auto',
            overflowY: 'hidden',
            paddingBottom: '6px',
          },
        },
          items.map((item) => {
            const selected = current && item.key === current.key
            return h('button', {
              key: item.key,
              type: 'button',
              title: captionOf(item) + (selected ? '（点一下回到最新）' : '（点一下钉住这张）'),
              onClick: () => setPinned((previous) => (previous === item.key ? '' : item.key)),
              style: {
                flex: '0 0 auto',
                width: '58px',
                height: '76px',
                padding: 0,
                borderRadius: '8px',
                overflow: 'hidden',
                cursor: 'pointer',
                background: 'var(--dsw-specific-input-major)',
                border: selected ? '2px solid var(--dsw-alias-brand-primary)' : '1px solid var(--dsw-alias-border-l1)',
                opacity: selected ? 1 : 0.82,
              },
            },
              h(DockImage, {
                src: item.url,
                alt: '',
                style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' },
              }))
          }),
        )
        : null

      const noteBlock = snapshot.note && items.length
        ? h('div', { style: { ...mutedText, marginTop: '8px', color: 'var(--dsw-alias-state-warn-primary)' } }, snapshot.note)
        : null

      const exportNoteBlock = exportNote
        ? h('div', {
          style: {
            marginTop: '8px',
            padding: '8px 10px',
            borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-specific-input-major)',
            ...mutedText,
            wordBreak: 'break-all',
          },
        }, exportNote)
        : null

      const drawNoteBlock = drawNote
        ? h('div', {
          style: {
            marginTop: '8px',
            padding: '8px 10px',
            borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-specific-input-major)',
            ...mutedText,
            wordBreak: 'break-all',
          },
        }, drawNote)
        : null

      const viewerBlock = viewing
        ? h('div', {
          role: 'dialog',
          'aria-label': '查看插图',
          tabIndex: -1,
          ref: (node) => { if (node) node.focus() },
          onClick: (event) => { if (event.target === event.currentTarget) setViewerIndex(-1) },
          onKeyDown: (event) => {
            if (event.key === 'Escape') setViewerIndex(-1)
            else if (event.key === 'ArrowLeft') stepViewer(-1)
            else if (event.key === 'ArrowRight') stepViewer(1)
          },
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 2147483000,
            background: 'rgba(0,0,0,.84)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            padding: '16px',
            boxSizing: 'border-box',
            outline: 'none',
          },
        },
          h(DockImage, {
            src: viewing.url,
            alt: viewing.caption || '插图',
            eager: true,
            style: { maxWidth: '92vw', maxHeight: '82vh', objectFit: 'contain', borderRadius: '8px' },
          }),
          h('div', { style: { color: '#e8edf5', fontSize: '12px', textAlign: 'center', maxWidth: '86vw', lineHeight: 1.5 } },
            (viewerIndex + 1) + ' / ' + items.length + ' · ' + captionOf(viewing) + '　（← → 翻页，Esc 关闭）'),
          viewing.jobId
            ? h('button', {
              type: 'button',
              disabled: exporting,
              onClick: () => { void runExport([viewing]) },
              style: {
                padding: '4px 12px',
                border: '1px solid rgba(255,255,255,.35)',
                borderRadius: '999px',
                background: 'rgba(255,255,255,.08)',
                color: '#fff',
                fontFamily: 'inherit',
                fontSize: '12px',
                cursor: exporting ? 'default' : 'pointer',
                opacity: exporting ? 0.6 : 1,
              },
            }, exporting ? '导出中…' : '存成 PNG')
            : null,
        )
        : null

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          maxHeight: '100%',
          minHeight: 0,
          overflow: 'hidden',
          boxSizing: 'border-box',
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-primary)',
        },
      },
        header,
        actionBar,
        // 整栏上下滚：大图按宽度铺满后，历史缩略图自然落到下面，要的时候再滚回来
        h('div', {
          style: {
            flex: '1 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            padding: '0 12px 14px',
          },
        },
          drawNoteBlock,
          exportNoteBlock,
          emptyBlock,
          heroBlock,
          runningBlock,
          stripBlock,
          noteBlock,
        ),
        viewerBlock,
      )
    }

    // ---------- 请求一次手动生图 ----------

    const drawingTurns = new Set()

    /** 让配图插件给某一轮画图：走它自己的 /attach-turn，和正文插图卡上的「配图」是同一条路。 */
    async function requestDraw(gameId, turn) {
      const id = String(gameId || '')
      const no = Number(turn) || 0
      if (!id || no < 1) throw new Error('这一轮还不能画图')
      const key = id + '#' + no
      if (drawingTurns.has(key)) return null
      drawingTurns.add(key)
      try {
        const response = await fetch(IMAGE_PLUGIN + '/attach-turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ gameId: id, turn: no }),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || (payload && payload.ok === false)) {
          throw new Error(String(payload?.error || 'HTTP ' + response.status))
        }
        return payload
      } finally {
        drawingTurns.delete(key)
      }
    }

    // ---------- 注册 ----------

    return {
      name: 'dsh-tavern-image-dock',
      inject: ['tavernUi'],
      apply(ctx) {
        const ui = ctx.tavernUi
        tavernUiService = ui || null
        if (!ui) return

        if (typeof ui.registerPanel === 'function') {
          try {
            ui.registerPanel({
              id: 'image-dock',
              title: '生图',
              render: ({ gameId }) => h(DockPanel, { gameId }),
            })
          } catch (error) {
            try { console.warn('[dsh-tavern-image-dock] 面板注册失败:', error?.message) } catch {}
          }
        }

        // 正文末尾那颗「画图」：给这一轮补一张（和插图卡上的配图同一条路）
        if (typeof ui.registerMessageAction === 'function') {
          try {
            ui.registerMessageAction({
              id: 'image-dock-draw',
              label: '画图',
              when: (context) => Boolean(context && context.settled && context.gameId && Number(context.turn) >= 1),
              run: async (context) => {
                try {
                  await requestDraw(context.gameId, context.turn)
                } catch (error) {
                  try { console.warn('[dsh-tavern-image-dock] 画图失败:', error?.message || error) } catch {}
                }
              },
            })
          } catch (error) {
            try { console.warn('[dsh-tavern-image-dock] 画图按钮注册失败:', error?.message) } catch {}
          }
        }
      },
    }
  },
})
