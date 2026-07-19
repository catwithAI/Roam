// P2P 直连下载状态机（M1，技术拆解 §4.3；评审点 2/3）。
//
// 状态：idle → picking → negotiating → (p2p | fallback) → http
//   - picking     ：点击的用户激活窗口内先弹 showSaveFilePicker + createWritable；
//                   用户取消即结束（不建 PC，不发任何信令）。
//   - negotiating ：拿到 handle 后才建 RTCPeerConnection + DataChannel('file')，
//                   经信令 WS 交换 SDP/ICE（transferId 校验，忽略串扰/迟到）。
//   - p2p         ：收 connected 设 path、清超时；收数据帧写入同一 writable，累加 goodput；
//                   收 eof → close writable 完成。
//   - fallback/http：超时(10s，灰度 8-12s) / pc failed / 收到 fallback / 源读错 →
//                   拆 dc/pc、ws 发 cancel、置 done（此后忽略该 transferId 的 connected/数据），
//                   再 fetch(/api/file/download) 把响应体 pipeTo 到「同一个 writable handle」，
//                   绝不 a[download]、绝不二次 picker。
//
// UI 极简（M1）：只透出 path / rate / 完成 / 失败回调；进度角标详版是 M2。

import { openSignal } from './signaling'
import { GoodputMeter, type PairDiag } from './stats'
import { pathLabelKey, type P2PPathLabel } from './labels'
import type { SignalMsg, CtrlFrame } from './types'

// 下载目标（对齐 FileBrowser 的 FileTarget 子集）。
export interface FileTarget {
  path: string
  name: string
  size?: number
  // 传输 op：真实下载=download（缺省）；spike 自测=spike（后端 serveSpike 发随机数据）。
  op?: 'download' | 'spike'
}

export type P2PState = 'idle' | 'picking' | 'negotiating' | 'p2p' | 'fallback' | 'http'

// 进度快照（喂角标/进度条/详情浮层，M2）。
export interface P2PProgress {
  written: number          // 已成功落盘字节（goodput 基准）
  total?: number           // 总量：优先 meta.size，回退用 target.size
  ratePerSec: number       // 实时 goodput（bytes/s）
  avgPerSec: number        // 平均 goodput（bytes/s，从首帧起算）
  etaSec?: number          // 预计剩余秒数；无总量/速率为 0 时 undefined
}

// UI 回调（M2 扩展集）。文案交调用方按 i18n key 渲染；这里只给稳定枚举/数值。
export interface DownloadHooks {
  // 状态机迁移（negotiating → p2p | fallback | http；done/error 由 onDone/onError 单独给）。
  onState?: (state: P2PState) => void
  // path 枚举变更：p2p 命中路径(ipv6-direct/upnp/stun/lan) 或回退 'frp'。
  onPath?: (label: P2PPathLabel) => void
  // 每秒落盘速率(bytes/s) + 累计字节，供进度/速率显示。
  onRate?: (ratePerSec: number, written: number) => void
  // 进度快照（含总量/平均速率/ETA），M2 角标+进度条用。
  onProgress?: (p: P2PProgress) => void
  // 候选对诊断（RTT / 两端 type / 地址族），仅进详情浮层，不当用户速率。
  onDiagnostics?: (d: PairDiag) => void
  // 是否已回退到 HTTP（frp）。
  onFallback?: (reason: string) => void
  // 传输成功完成（p2p 或回退都会回调一次）。
  onDone?: () => void
  // 不可恢复的失败（回退也失败时）。
  onError?: (message: string) => void
}

const FALLBACK_TIMEOUT_MS = 10_000 // 建链超时，灰度区间 8–12s
const STALL_TIMEOUT_MS = 15_000    // 连后「无进展看门狗」：连续 N 秒无 meta/数据帧即判卡死回退

// 埋点上报（§7/§10）：真实 download 完成时 POST /api/p2p/metric（同源 cookie 自动带）。
// 仅真实 download 走此路；roamP2PVerify/spike 测试钩子不传 report → 不上报。
export interface MetricPayload {
  transferId: string
  path: P2PPathLabel        // 实际走的路（含回退 'frp'）
  avgGoodputBps: number     // 平均 goodput（bytes/s）
  sizeBytes: number         // 已落盘总字节
  fellBack: boolean         // 是否回退到 frp
  durationMs: number        // 从发起到完成的墙钟耗时
}

function reportMetric(m: MetricPayload): void {
  try {
    void fetch('/api/p2p/metric', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(m),
      cache: 'no-store',
      keepalive: true, // 页面卸载时也尽量送出
    }).catch(() => { /* 埋点失败静默，不影响下载 */ })
  } catch { /* ignore */ }
}

interface P2PConfig {
  iceServers?: RTCIceServer[]
}

// 拉后端 ICE 配置。同源 fetch 自动带 cookie。失败回空数组（走无 STUN 的本机/LAN 直连）。
async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const r = await fetch('/api/p2p/config', { cache: 'no-store' })
    if (!r.ok) return []
    const data = await r.json().catch(() => null)
    const cfg: P2PConfig = data?.data ?? data ?? {}
    return Array.isArray(cfg.iceServers) ? cfg.iceServers : []
  } catch {
    return []
  }
}

// 下载「落地目标」的抽象：既可写进 showSaveFilePicker 的 handle（正式下载），
// 也可写进内存 Blob（roamP2PVerify 完整性冒烟，绕过 picker）。
interface Sink {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
}

// —— 状态机核心：拿到 sink 后走完整 negotiating → p2p/fallback → http —— //
// 供 download()（真实 handle）与 roamP2PVerify()（Blob sink）共用，唯一差别是 sink 与是否回退。
async function runTransfer(
  target: FileTarget,
  sink: Sink,
  hooks: DownloadHooks,
  opts: { allowFallback: boolean; report?: boolean },
): Promise<void> {
  const transferId = crypto.randomUUID()
  const done = { flag: false } // 终结标志：置 1 后忽略该 transferId 的迟到 connected/数据
  let written = 0
  let total: number | undefined = target.size // meta.size 到达后覆盖
  let state: P2PState = 'negotiating'
  let curPath: P2PPathLabel = 'stun' // 实际路径，供埋点；回退置 'frp'
  let fellBack = false
  const startedAt = performance.now()
  let firstByteAt = 0 // 首个落盘字节时刻，算平均 goodput 用

  const ws = openSignal()
  const pc = new RTCPeerConnection({ iceServers: await fetchIceServers() })
  const dc = pc.createDataChannel('file', { ordered: true })
  dc.binaryType = 'arraybuffer'

  // 进度快照：实时速率来自 meter，平均从首字节起算，ETA = 剩余/实时速率。
  const emitProgress = (ratePerSec: number) => {
    if (done.flag) return
    const avgPerSec = firstByteAt > 0 ? written / ((performance.now() - firstByteAt) / 1000) : 0
    let etaSec: number | undefined
    if (total && total > written && ratePerSec > 0) etaSec = (total - written) / ratePerSec
    hooks.onProgress?.({ written, total, ratePerSec, avgPerSec, etaSec })
  }

  const meter = new GoodputMeter(() => written, pc)
  meter.onSample = (s) => {
    if (done.flag) return
    hooks.onRate?.(s.ratePerSec, s.written)
    if (s.diag) hooks.onDiagnostics?.(s.diag)
    emitProgress(s.ratePerSec)
  }

  const wsSend = (m: SignalMsg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
  }

  // 连后「无进展看门狗」句柄（收 meta/数据帧即重置；连续 STALL 秒无进展 → 回退）。
  let stallTimer = 0
  const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = 0 } }

  // 拆连接（幂等）：dc/pc/ws 全关、停采样、停两个看门狗。
  const teardown = () => {
    meter.stop()
    clearStall()
    try { dc.close() } catch { /* ignore */ }
    try { pc.close() } catch { /* ignore */ }
    try { ws.close() } catch { /* ignore */ }
  }

  return new Promise<void>((resolve) => {
    let settled = false
    const settle = () => { if (!settled) { settled = true; resolve() } }

    // 上报埋点（仅真实 download：opts.report 为真时）。
    const maybeReport = () => {
      if (!opts.report) return
      const durationMs = performance.now() - startedAt
      const avgGoodputBps = durationMs > 0 ? (written * 1000) / durationMs : 0
      reportMetric({
        transferId,
        path: fellBack ? 'frp' : curPath,
        avgGoodputBps,
        sizeBytes: written,
        fellBack,
        durationMs,
      })
    }

    // 连后无进展看门狗：每收到 meta/数据帧调一次重置；超 STALL 秒无进展即判卡死回退。
    // 修 M1「连上后错误帧丢失/后端卡死 → 前端永久挂起」的挂起 bug。
    const bumpStall = () => {
      if (done.flag) return
      clearStall()
      stallTimer = window.setTimeout(() => { void toFallback('stall') }, STALL_TIMEOUT_MS)
    }

    // 成功完成：关 sink → onDone → 埋点。
    const complete = async () => {
      done.flag = true
      clearTimeout(fallbackTimer)
      clearStall()
      teardown()
      try {
        await sink.close()
        maybeReport()
        hooks.onDone?.()
      } catch (e: any) {
        hooks.onError?.(String(e?.message ?? e))
      }
      settle()
    }

    // 回退（评审点3）：拆干净 + 通知后端 cancel + 置 done（此后迟到消息全忽略），
    // 再 fetch 同 URL 把响应体 pipeTo 到同一个 sink —— 绝不二次 picker / a[download]。
    const toFallback = async (reason: string) => {
      if (done.flag || state === 'http' || state === 'fallback') return
      state = 'fallback'
      hooks.onState?.('fallback')
      clearTimeout(fallbackTimer)
      clearStall()
      wsSend({ type: 'cancel', transferId, reason })
      done.flag = true // 之后该 transferId 的 connected/数据一律忽略
      teardown()

      if (!opts.allowFallback) {
        // roamP2PVerify 场景：p2p 失败即失败，不回退到 HTTP（避免污染完整性冒烟）。
        try { await sink.close() } catch { /* ignore */ }
        hooks.onError?.(reason)
        settle()
        return
      }

      state = 'http'
      fellBack = true
      curPath = 'frp'
      hooks.onState?.('http')
      hooks.onFallback?.(reason)
      hooks.onPath?.('frp')
      // 回退期 goodput：从 http 首字节起算平均（重置 firstByteAt，避免掺入 p2p 段）。
      firstByteAt = 0
      written = 0
      const httpStart = performance.now()
      let last = httpStart
      let lastWritten = 0
      try {
        const res = await fetch(`/api/file/download?path=${encodeURIComponent(target.path)}`, { cache: 'no-store' })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        // pipeTo 直接把响应流写进同一个 writable（不经内存、不二次弹窗），顺带算回退速率/进度。
        await res.body.pipeTo(new WritableStream<Uint8Array>({
          write: (chunk) => {
            if (firstByteAt === 0) firstByteAt = performance.now()
            written += chunk.byteLength
            const now = performance.now()
            if (now - last >= 500) {
              const rate = (written - lastWritten) / ((now - last) / 1000)
              last = now; lastWritten = written
              hooks.onRate?.(rate, written)
              emitProgress(rate)
            }
            return sink.write(chunk)
          },
          close: () => sink.close(),
        }))
        emitProgress(0)
        maybeReport()
        hooks.onDone?.()
      } catch (e: any) {
        try { await sink.close() } catch { /* ignore */ }
        hooks.onError?.(String(e?.message ?? e))
      }
      settle()
    }

    const fallbackTimer = window.setTimeout(() => { void toFallback('timeout') }, FALLBACK_TIMEOUT_MS)

    pc.onicecandidate = (e) => {
      if (e.candidate) wsSend({ type: 'ice', transferId, candidate: e.candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') void toFallback('ice-failed')
    }

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return // 信令只走 text
      let m: SignalMsg
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.transferId !== transferId || done.flag) return // 忽略串扰/迟到
      if (m.type === 'answer' && m.sdp) {
        pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => { /* ignore */ })
      } else if (m.type === 'ice' && m.candidate) {
        pc.addIceCandidate(m.candidate).catch(() => { /* 迟到候选忽略 */ })
      } else if (m.type === 'connected') {
        state = 'p2p'
        curPath = (m.path as P2PPathLabel) ?? 'stun'
        clearTimeout(fallbackTimer) // 清建链超时…
        bumpStall()                 // …并起「无进展看门狗」（收数据帧会持续重置）
        hooks.onState?.('p2p')
        hooks.onPath?.(curPath)
        // connected 也可能直接带诊断（local/remote/rttMs），先喂一份给详情浮层。
        if (m.rttMs != null || m.local || m.remote) {
          hooks.onDiagnostics?.({
            rttMs: m.rttMs,
            localType: m.local?.type,
            remoteType: m.remote?.type,
            localFamily: m.local?.family,
            remoteFamily: m.remote?.family,
          })
        }
        void pathLabelKey(m.path) // 标签映射由 UI 层用；这里仅确保枚举稳定
        meter.start()
      } else if (m.type === 'fallback') {
        void toFallback(m.reason ?? 'fallback')
      }
    }
    ws.onclose = () => { if (!done.flag && state !== 'http' && state !== 'fallback') void toFallback('ws-closed') }

    dc.onmessage = (ev) => {
      if (done.flag) return
      bumpStall() // 任何帧都算「有进展」，重置无进展看门狗
      if (typeof ev.data === 'string') { // 控制帧
        let f: CtrlFrame
        try { f = JSON.parse(ev.data) } catch { return }
        if (f.t === 'meta') {
          // meta.size 作为进度总量（比 target.size 权威）。
          if (typeof f.size === 'number' && f.size >= 0) total = f.size
          hooks.onRate?.(0, written)
          emitProgress(0)
        } else if (f.t === 'eof') {
          void complete()
        } else if (f.t === 'error') {
          void toFallback('src-error')
        }
        return
      }
      // 数据帧：[seq:u32 LE][payload]，写入 sink（跳过 4 字节 seq 头）。
      if (firstByteAt === 0) firstByteAt = performance.now()
      const buf = ev.data as ArrayBuffer
      const payload = new Uint8Array(buf, 4)
      const p = sink.write(payload)
      written += payload.byteLength
      void p
    }

    hooks.onState?.('negotiating')

    // 发起 offer（带 transferId + transfer）。op 由调用方给（真实下载=download；spike=spike）。
    ;(async () => {
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        const sendOffer = () => wsSend({
          type: 'offer',
          transferId,
          sdp: offer.sdp,
          transfer: { path: target.path, op: target.op ?? 'download' },
        })
        if (ws.readyState === WebSocket.OPEN) sendOffer()
        else ws.addEventListener('open', sendOffer, { once: true })
      } catch (e) {
        void toFallback('offer-failed')
      }
    })()
  })
}

// —— M1 正式入口：picker 先行的状态机下载 —— //
export async function download(target: FileTarget, hooks: DownloadHooks = {}): Promise<void> {
  // picking：必须在点击的用户激活窗口内先弹（不能等 ICE），拿到 handle 才继续。
  // FileSystemWritableFileStream 类型在 lib.dom 各版本对 Uint8Array<ArrayBufferLike> 挑剔，
  // 这里按 File System Access 实际契约用 any 收 writable。
  let writable: { write: (c: Uint8Array) => Promise<void>; close: () => Promise<void> }
  try {
    const handle = await (window as any).showSaveFilePicker({ suggestedName: target.name })
    writable = await handle.createWritable()
  } catch {
    return // 用户取消 → 结束，不建 PC、不发信令
  }

  const sink: Sink = {
    write: (chunk) => writable.write(chunk),
    close: () => writable.close(),
  }
  // report:true —— 只有真实 download 才上报埋点；测试钩子(spike/verify)不传即不上报。
  await runTransfer(target, sink, hooks, { allowFallback: true, report: true })
}

// ============================ 测试钩子（dev/temp） ============================ //

// [临时/仅开发] M0a transport 自测：收随机字节流丢弃，只统计吞吐并打印。
// 挂在 window.roamP2PSpike，供控制台手测传输层是否通。M1 落地后可与后端 spike op 一并移除。
// 健壮性修复②：不带参数走 op:'spike'（后端 serveSpike 发随机数据），不再 /dev/urandom + download
// —— /dev/urandom 会命中后端 not-regular-file 守卫而失败。仅显式传 path 时才走 op:'download'。
export async function spike(path?: string): Promise<void> {
  const target: FileTarget = path
    ? { path, name: 'spike', op: 'download' }
    : { path: '', name: 'spike', op: 'spike' }
  const t0 = performance.now()
  let total = 0
  const sink: Sink = {
    write: (chunk) => { total += chunk.byteLength; return Promise.resolve() }, // 丢弃
    close: () => Promise.resolve(),
  }
  await runTransfer(target, sink, {
    onPath: (p) => console.log('[p2p-spike] connected via', p),
    onDone: () => {
      const elapsed = (performance.now() - t0) / 1000
      const mbps = elapsed > 0 ? (total * 8) / 1e6 / elapsed : 0
      console.log(`[p2p-spike] done total=${(total / 1e6).toFixed(2)}MB elapsed=${elapsed.toFixed(2)}s avg=${mbps.toFixed(2)}Mbps`)
    },
    onError: (m) => console.warn('[p2p-spike] error', m),
  }, { allowFallback: false })
}

// [临时/仅开发] M1 完整性冒烟：走完整协商，但把真实文件收进内存 Blob（绕过 picker），
// 用 crypto.subtle 算 sha256，打印 size + sha256（供自动化对比后端文件哈希）。
// 挂在 window.roamP2PVerify(path)。allowFallback:false —— 只验 p2p 直连本身。
export async function verify(path: string): Promise<{ size: number; sha256: string } | undefined> {
  const chunks: Uint8Array[] = []
  const sink: Sink = {
    write: (chunk) => { chunks.push(new Uint8Array(chunk)); return Promise.resolve() },
    close: () => Promise.resolve(),
  }
  let ok = false
  await runTransfer({ path, name: path.split('/').pop() || 'file' }, sink, {
    onDone: () => { ok = true },
    onError: (m) => console.warn('[p2p-verify] error', m),
  }, { allowFallback: false })
  if (!ok) { console.warn('[p2p-verify] transfer did not complete'); return undefined }

  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const merged = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { merged.set(c, off); off += c.byteLength }
  const digest = await crypto.subtle.digest('SHA-256', merged)
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  console.log(`[p2p-verify] path=${path} size=${total} sha256=${sha256}`)
  return { size: total, sha256 }
}

// 兼容旧入口名（main.tsx 曾用 spikeConnect）。
export const spikeConnect = spike
