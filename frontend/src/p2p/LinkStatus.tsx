// 左边栏全局 P2P 链路状态（设计 §3）。
//
// 反映会话主连接（control PC）状态：
//   connecting → 「… 连接中」
//   connected  → 「⚡ 直连 · <path 标签>」（绿）
//   relay      → 「↻ 中转」（琥珀）
//   disabled   → 隐藏（未启用/偏好关）
// 点开详情浮层：control 链路 path、RTT 诊断、（预留 media/file 位）。
//
// 数据源：信令 link 消息 → transport.ts 的 store（subscribeLink/getLinkStatus）。
// 复用 M2 的 pathLabelKey/i18n；新增文案走 i18n（zh-CN/en-US）。

import { useState, useSyncExternalStore } from 'react'
import { useI18n } from '../i18n'
import { pathLabelKey } from './labels'
import { subscribeLink, getLinkStatus, type LinkState } from './transport'

// 订阅全局 control 链路状态。
function useLinkStatus() {
  return useSyncExternalStore(subscribeLink, getLinkStatus, getLinkStatus)
}

// 预留子链路（media/file）状态行的 i18n key。
const SUBLINK_STATE_KEY: Record<LinkState, string> = {
  disabled: 'p2p.link.sub.idle',
  connecting: 'p2p.link.sub.connecting',
  connected: 'p2p.link.sub.connected',
  relay: 'p2p.link.sub.relay',
}

// collapsed：左边栏折叠时只显图标点（不显文案），点开详情仍可用。
export function LinkStatus({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useI18n()
  const status = useLinkStatus()
  const [open, setOpen] = useState(false)

  // 未启用（偏好关 / P2P 不可用）→ 隐藏整块。
  if (status.state === 'disabled') return null

  const isP2P = status.state === 'connected'
  const isRelay = status.state === 'relay'

  let color = 'var(--text-dim)'
  let bg = 'rgba(148,163,184,0.14)'
  let icon = '…'
  let text: string
  if (isP2P) {
    color = '#3fb950'; bg = 'rgba(63,185,80,0.14)'; icon = '⚡'
    text = t('p2p.link.direct', { path: t(pathLabelKey(status.path)) })
  } else if (isRelay) {
    color = '#d29922'; bg = 'rgba(210,153,34,0.16)'; icon = '↻'
    text = t('p2p.link.relay')
  } else {
    icon = '…'
    text = t('p2p.link.connecting')
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={text}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
          border: 'none', borderRadius: 6, padding: collapsed ? '4px 6px' : '4px 10px',
          fontSize: 12, fontWeight: 600, color, background: bg,
          width: '100%', justifyContent: collapsed ? 'center' : 'flex-start',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        <span aria-hidden style={{ flex: '0 0 auto' }}>{icon}</span>
        {!collapsed && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>}
      </button>

      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, zIndex: 60,
          minWidth: 220, padding: '8px 10px', borderRadius: 8, fontSize: 12,
          background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
          boxShadow: '0 6px 20px rgba(0,0,0,.35)',
        }}>
          <div style={{ fontWeight: 700, color: 'var(--text-bright)', marginBottom: 6 }}>{t('p2p.link.title')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0,1fr)', gap: '4px 10px' }}>
            <span style={{ color: 'var(--text-dim)' }}>{t('p2p.link.control')}</span>
            <span style={{ color, fontWeight: 600 }}>
              {isP2P ? t('p2p.link.direct', { path: t(pathLabelKey(status.path)) }) : isRelay ? t('p2p.link.relay') : t('p2p.link.connecting')}
            </span>

            <span style={{ color: 'var(--text-dim)' }}>{t('p2p.detail.path')}</span>
            <span style={{ color: 'var(--text-bright)' }}>{isP2P ? t(pathLabelKey(status.path)) : t('p2p.detail.na')}</span>

            <span style={{ color: 'var(--text-dim)' }}>{t('p2p.detail.rtt')}</span>
            <span>{status.rttMs != null && status.rttMs > 0 ? t('p2p.detail.rttMs', { ms: Math.round(status.rttMs) }) : t('p2p.detail.na')}</span>

            {/* media 类 PC（Phase 1b：镜像）。connected 时带命中路径，与主连接同款展示。 */}
            <span style={{ color: 'var(--text-dim)' }}>{t('p2p.link.media')}</span>
            <span style={{ color: 'var(--text-dimmer)' }}>
              {status.media === 'connected'
                ? t('p2p.link.sub.directPath', { path: t(pathLabelKey(status.mediaPath)) })
                : t(SUBLINK_STATE_KEY[status.media ?? 'disabled'])}
            </span>

            {/* file 类临时 PC（下载时按需建，用完即拆）。connected 时带命中路径，与 media 同款展示。 */}
            <span style={{ color: 'var(--text-dim)' }}>{t('p2p.link.file')}</span>
            <span style={{ color: 'var(--text-dimmer)' }}>
              {status.file === 'connected'
                ? t('p2p.link.sub.directPath', { path: t(pathLabelKey(status.filePath)) })
                : t(SUBLINK_STATE_KEY[status.file ?? 'disabled'])}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

export default LinkStatus
