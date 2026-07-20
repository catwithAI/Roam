// 自托管流式落盘客户端（StreamSaver 思路，全同源，不依赖被墙的外部 mitm 源）。
//
// 让「移动端 / 无 showSaveFilePicker」的浏览器也能把一个前端产生的字节流当 attachment 下载 ——
// 边收边落盘、不占内存、支持任意大小。资源自托管在 public/streamsaver/{mitm.html,sw.js}。
//
// 用法（必须在用户手势内 createStreamWriter，SW 触发下载需要用户激活）：
//   const w = await createStreamWriter({ name, size })  // 建 iframe + 注册 SW + 拿到写入口
//   await w.write(chunk)  // P2P 每个 chunk 直接推给 SW 的 ReadableStream
//   await w.close()       // eof：关流，浏览器完成落盘
//   w.abort()             // 失败：中断（触发不了下载 / 中途出错）
//
// 能力判断 canStreamSave()：需 service worker + MessageChannel + 安全上下文（app 已 https）。

// mitm iframe 与「就绪」Promise 全局单例（一次注册，多次下载复用）。
let mitmFrame: HTMLIFrameElement | null = null
let mitmReady: Promise<HTMLIFrameElement> | null = null

const MITM_URL = '/streamsaver/mitm.html'

// 是否具备自托管流式落盘能力：SW + 安全上下文 + MessageChannel。
// 不在这里探测 SW 是否真能注册成功（那要异步且有副作用）；注册失败由 createStreamWriter 抛错兜底。
export function canStreamSave(): boolean {
  try {
    return (
      typeof MessageChannel === 'function' &&
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      (self.isSecureContext === true || location.hostname === 'localhost')
    )
  } catch {
    return false
  }
}

// 建好（或复用）mitm iframe，并等它 postMessage 'streamsaver-mitm-ready'。
function ensureMitm(): Promise<HTMLIFrameElement> {
  if (mitmReady) return mitmReady
  mitmReady = new Promise<HTMLIFrameElement>((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.setAttribute('aria-hidden', 'true')
    frame.style.display = 'none'
    frame.src = MITM_URL
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('streamsaver mitm timeout'))
    }, 10_000)
    const onMsg = (e: MessageEvent) => {
      if (e.source === frame.contentWindow && e.data === 'streamsaver-mitm-ready') {
        window.clearTimeout(timer)
        window.removeEventListener('message', onMsg)
        mitmFrame = frame
        resolve(frame)
      }
    }
    const cleanup = () => {
      window.removeEventListener('message', onMsg)
      try { frame.remove() } catch { /* ignore */ }
      mitmReady = null
    }
    window.addEventListener('message', onMsg)
    document.body.appendChild(frame)
  })
  return mitmReady
}

// 一个流式写入口：把 chunk 推给 SW 的 ReadableStream，close/abort 收尾。
export interface StreamWriter {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
  abort(): void
}

// 触发对下载 url 的导航请求（命中 SW fetch 拦截 → attachment 响应）。用隐藏 iframe，不打断宿主页面。
function triggerNavigation(url: string): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.style.display = 'none'
  frame.src = url
  document.body.appendChild(frame)
  return frame
}

// 建一个流式写入口。必须在用户手势内调用（SW 弹下载需要用户激活）。
export async function createStreamWriter(opts: { name: string; size?: number }): Promise<StreamWriter> {
  const frame = await ensureMitm()
  const win = frame.contentWindow
  if (!win) throw new Error('streamsaver mitm window missing')

  // 唯一下载路径：/streamsaver/<rand>/<encoded name>（落在 SW scope 内，才会被拦截）。
  const rand = Math.random().toString(36).slice(2) + Date.now().toString(36)
  const downloadUrl = `/streamsaver/${rand}/${encodeURIComponent(opts.name || 'download')}`

  const channel = new MessageChannel()
  const port = channel.port1

  let aborted = false
  let closed = false

  // 等 SW 回执 { download } 后才触发导航 —— 保证 SW 已登记该 url。
  let navFrame: HTMLIFrameElement | null = null
  const ready = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('streamsaver register timeout')), 10_000)
    port.onmessage = (e) => {
      const m = e.data
      if (m && m.download) {
        window.clearTimeout(timer)
        navFrame = triggerNavigation(m.download)
        resolve()
      } else if (m && m.error) {
        window.clearTimeout(timer)
        reject(new Error(String(m.error)))
      } else if (m === 'cancelled') {
        // 下载被取消：让写入侧后续 write/close 变 no-op（不抛，避免打断已完成的 P2P）。
        aborted = true
      }
    }
  })

  // 登记：把 port2 转交给 mitm → SW。
  win.postMessage(
    { type: 'register-download', url: downloadUrl, filename: opts.name, size: opts.size, headers: {} },
    '*',
    [channel.port2],
  )
  await ready

  const cleanupNav = () => {
    if (navFrame) {
      const f = navFrame
      navFrame = null
      window.setTimeout(() => { try { f.remove() } catch { /* ignore */ } }, 20_000)
    }
  }

  return {
    write(chunk: Uint8Array): Promise<void> {
      if (aborted || closed) return Promise.resolve()
      // 转移底层 buffer，零拷贝送给 SW。chunk 可能是别人 buffer 的视图，拷一份保证可转移。
      const copy = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
        ? chunk
        : new Uint8Array(chunk)
      try { port.postMessage(copy, [copy.buffer]) } catch { port.postMessage(copy) }
      return Promise.resolve()
    },
    close(): Promise<void> {
      if (!aborted && !closed) { closed = true; try { port.postMessage('end') } catch { /* ignore */ } }
      cleanupNav()
      try { port.close() } catch { /* ignore */ }
      return Promise.resolve()
    },
    abort(): void {
      if (!closed) { aborted = true; try { port.postMessage('abort') } catch { /* ignore */ } }
      cleanupNav()
      try { port.close() } catch { /* ignore */ }
    },
  }
}
