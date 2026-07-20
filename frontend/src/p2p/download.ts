// P2P 直连下载「文件协议层」（M1，技术拆解 §4.3；评审点 2/3）。
//
// 底层（PC/ICE/信令/offer-answer-ice/候选 trickle/连链超时/回退触发）已全部收敛到 transport.ts
// 的 connectFile()——本文件不再自造 RTCPeerConnection/openSignal/ICE 处理，只留【文件协议层】：
// 发/收 meta、[seq] 分块、sink 选择、状态机、http 回退、埋点。
//
// 状态：idle → picking → negotiating → (p2p | fallback) → http
//   - picking     ：点击的用户激活窗口内先弹 showSaveFilePicker + createWritable；
//                   用户取消即结束（不建 PC，不发任何信令）。
//   - negotiating ：拿到 handle 后才 connectFile()（transport 建临时 file PC + 'file' 通道 + 协商）。
//   - p2p         ：onConnected 设 path、清超时；收数据帧写入同一 writable，累加 goodput；
//                   收 eof → close writable 完成。
//   - fallback/http：连链超时(30s) / pc failed / onFallback / 源读错 / 连后无进展看门狗 →
//                   peer.sendCancel + close（此后忽略迟到消息），
//                   再 fetch(/api/file/download) 把响应体 pipeTo 到「同一个 writable handle」，
//                   绝不 a[download]、绝不二次 picker。
//
// UI 极简（M1）：只透出 path / rate / 完成 / 失败回调；进度角标详版是 M2。

import { connectFile } from './transport'
import { GoodputMeter, type PairDiag } from './stats'
import { pathLabelKey, type P2PPathLabel } from './labels'
import { canStreamSave, createStreamWriter } from './stream-saver'
import type { CtrlFrame } from './types'

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

// 连链超时（30s）已下沉到 transport.connectFile（超时→peer.onFallback）；本层只留【连后】看门狗：
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

// 下载「落地目标」的抽象：既可写进 showSaveFilePicker 的 handle（正式下载），
// 也可写进内存 Blob（roamP2PVerify 完整性冒烟，绕过 picker）。
interface Sink {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
  // 可选：不可恢复失败时中断落地（StreamSink 用它让浏览器下载报错，而非落一个截断文件）。
  // picker/Blob sink 不实现（close 即可）。
  abort?(): void
}

// —— 状态机核心：拿到 sink 后走完整 negotiating → p2p/fallback → http —— //
// 供 download()（真实 handle）与 roamP2PVerify()（Blob sink）共用，唯一差别是 sink 与是否回退。
async function runTransfer(
  target: FileTarget,
  sink: Sink,
  hooks: DownloadHooks,
  opts: { allowFallback: boolean; report?: boolean },
): Promise<void> {
  const done = { flag: false } // 终结标志：置 1 后忽略迟到 connected/数据
  let written = 0
  let total: number | undefined = target.size // meta.size 到达后覆盖
  let state: P2PState = 'negotiating'
  let curPath: P2PPathLabel = 'stun' // 实际路径，供埋点；回退置 'frp'
  let fellBack = false
  const startedAt = performance.now()
  let firstByteAt = 0 // 首个落盘字节时刻，算平均 goodput 用

  // 底层建链全托给 transport.connectFile()：临时 file PC + 'file' 可靠通道 + offer-answer-ice + 连链超时。
  // 拿回业务通道(tp)、pc（取 RTT）、transferId（发 cancel）、connected/fallback 事件。
  const peer = await connectFile({ path: target.path, op: target.op ?? 'download' })
  const { tp, pc, transferId } = peer

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

  // 连后「无进展看门狗」句柄（收 meta/数据帧即重置；连续 STALL 秒无进展 → 回退）。
  let stallTimer = 0
  const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = 0 } }

  // 拆连接（幂等）：停采样、停看门狗，底层 PC/dc/ws 交给 transport.close()。
  const teardown = () => {
    meter.stop()
    clearStall()
    try { peer.close() } catch { /* ignore */ }
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
      clearStall()
      teardown()
      try {
        await sink.close()
        maybeReport()
        hooks.onDone?.()
      } catch (e: any) {
        try { sink.abort?.() } catch { /* ignore */ }
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
      clearStall()
      peer.sendCancel(reason) // 通知后端拆 file PC
      done.flag = true // 之后该 transferId 的 connected/数据一律忽略
      teardown()

      if (!opts.allowFallback) {
        // roamP2PVerify / Blob 场景：p2p 失败即失败，不回退到 HTTP（避免污染完整性冒烟/二次下载）。
        // 有 abort（StreamSink）则中断落地让下载报错；否则 close（Blob/spike 语义是内存/丢弃）。
        try { if (sink.abort) sink.abort(); else await sink.close() } catch { /* ignore */ }
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
        // frp 回退也失败：中断流式落地（StreamSink）让下载报错，避免落一个截断文件。
        try { if (sink.abort) sink.abort(); else await sink.close() } catch { /* ignore */ }
        hooks.onError?.(String(e?.message ?? e))
      }
      settle()
    }

    // 连上：transport 收 connected → 设 path、起「无进展看门狗」、喂诊断、启动 goodput 采样。
    // （连链超时/ICE failed/WS 断/后端 fallback 由 transport 统一走 peer.onFallback → toFallback。）
    peer.onConnected = (path, diag) => {
      if (done.flag) return
      state = 'p2p'
      curPath = path
      bumpStall() // 起「无进展看门狗」（收数据帧会持续重置）
      hooks.onState?.('p2p')
      hooks.onPath?.(curPath)
      // connected 也可能直接带诊断（local/remote/rttMs），先喂一份给详情浮层。
      if (diag.rttMs != null || diag.localType || diag.remoteType) {
        hooks.onDiagnostics?.(diag)
      }
      void pathLabelKey(path) // 标签映射由 UI 层用；这里仅确保枚举稳定
      meter.start()
    }
    // 底层回退：连链超时 / ICE failed / 信令 WS 断 / 后端 fallback → 走 http 回退。
    peer.onFallback = (reason) => { void toFallback(reason) }

    // 业务通道消息（meta/[seq]分块/eof/error）——纯文件协议层，托底层无关。
    tp.onmessage = (data) => {
      if (done.flag) return
      bumpStall() // 任何帧都算「有进展」，重置无进展看门狗
      if (typeof data === 'string') { // 控制帧
        let f: CtrlFrame
        try { f = JSON.parse(data) } catch { return }
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
      const buf = data as ArrayBuffer
      const payload = new Uint8Array(buf, 4)
      const p = sink.write(payload)
      written += payload.byteLength
      void p
    }
    // 通道意外关闭：若还没进 http/完成，判回退（超时/fallback 另有 peer.onFallback 兜底）。
    tp.onclose = () => { if (!done.flag && state !== 'http' && state !== 'fallback') void toFallback('dc-closed') }

    hooks.onState?.('negotiating')
  })
}

// Blob sink 的大小上限：超过则不走内存累积（防 OOM），改由调用方回退系统下载。
// 有 showSaveFilePicker 的浏览器不受此限（边收边落盘，不占内存）。
const BLOB_SINK_MAX_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB

// 触发浏览器把内存 Blob 存成文件（Blob sink 收完 eof 后调用）。
function triggerBlobDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 给浏览器一点时间把 URL 交给下载栈，再释放对象 URL。
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// —— M1 正式入口：自动 sink 的状态机下载（三级落地能力择优） —— //
// 按浏览器能力选落地方式，前两条都是「流式落盘」（边收边落、不占内存、支持任意大小、
// 状态机内可原地 pipeTo frp 回退），只有第三条 Blob 受内存限制：
//   1) showSaveFilePicker 可用（Chromium 桌面）→ 用户激活窗口内先弹 picker → WritableStream 边收边落盘。
//   2) 否则自托管 StreamSaver 可用（移动端 Chrome / Firefox / Safari）→ StreamSink：
//      点击手势内先建 writable（SW 弹下载需用户激活），P2P 每个 chunk 直接写进流，eof 关流。
//   3) 都不可用 → Blob sink：P2P 收流累积进内存，eof 后 a[download] 触发；超 Blob 上限才最终回退 frp。
// blobFallback：Blob 路径本身失败时的兜底（触发 legacy frp 系统下载），由调用方注入。
export async function download(
  target: FileTarget,
  hooks: DownloadHooks = {},
  opts: { blobFallback?: () => void } = {},
): Promise<void> {
  const canPicker = typeof (window as any).showSaveFilePicker === 'function'

  if (canPicker) {
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
    return
  }

  // 无 picker 但自托管流式落盘可用（移动端/Firefox/Safari）：StreamSink 边收边落盘、不占内存、任意大小。
  // writable 必须在点击手势内先建（SW 弹下载需用户激活）；建失败/被墙等再降级 Blob。
  if (canStreamSave()) {
    let writer: { write: (c: Uint8Array) => Promise<void>; close: () => Promise<void>; abort: () => void } | null = null
    try {
      writer = await createStreamWriter({ name: target.name, size: target.size })
    } catch {
      writer = null // SW 注册/触发失败 → 降级 Blob 路径
    }
    if (writer) {
      const w = writer
      const sink: Sink = {
        write: (chunk) => w.write(chunk),
        close: () => w.close(),
        abort: () => w.abort(),
      }
      // allowFallback:true —— StreamSink 是真流，状态机可原地把 frp 响应体 pipeTo 同一流（不占内存、不二次弹窗）。
      await runTransfer(target, sink, hooks, { allowFallback: true, report: true })
      return
    }
  }

  // 三级：Blob sink（无 picker 且无 StreamSaver）。Blob 过大则不进内存，直接回退系统下载（frp）。
  if (typeof target.size === 'number' && target.size > BLOB_SINK_MAX_BYTES) {
    opts.blobFallback?.()
    return
  }

  // Blob sink：P2P 收流累积进内存，eof（sink.close）后拼成 Blob 触发浏览器下载。
  // allowFallback:false —— Blob 路径不在状态机里 pipeTo frp（sink 语义是内存累积，
  // 中途改写 frp 会二次下载/污染）。改由 onError 兜底触发 legacy frp 系统下载。
  const chunks: Uint8Array[] = []
  const sink: Sink = {
    write: (chunk) => { chunks.push(new Uint8Array(chunk)); return Promise.resolve() },
    close: () => { triggerBlobDownload(new Blob(chunks as BlobPart[]), target.name); return Promise.resolve() },
  }
  let fellBackViaBlob = false
  await runTransfer(target, sink, {
    ...hooks,
    onError: (msg) => {
      // P2P 协商/传输真失败 → 触发 legacy frp 系统下载（唯一一次），不再回调上层 onError。
      fellBackViaBlob = true
      chunks.length = 0 // 释放已累积内存
      hooks.onFallback?.(msg)
      hooks.onPath?.('frp')
      opts.blobFallback?.()
      hooks.onDone?.()
    },
    onDone: () => { if (!fellBackViaBlob) hooks.onDone?.() },
  }, { allowFallback: false, report: true })
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
