/* Roam 自托管流式落盘 Service Worker（StreamSaver 协议精简版）。
 *
 * 作用：让「移动端 / 无 showSaveFilePicker 的浏览器」也能把一个前端产生的
 * ReadableStream 当作 attachment 下载 —— 边收边落盘，不把整文件塞进内存/Blob。
 *
 * 为什么单独一个 SW（不复用 PWA /sw.js）：
 *   - 作用域隔离：注册时 scope='/streamsaver/'，本 SW 只拦截 /streamsaver/** 下的下载 URL，
 *     绝不碰 /api（终端/WS）、导航或其它静态资源，与 PWA 外壳 SW 互不干扰。
 *   - 全同源自托管：mitm.html + sw.js 都在 /streamsaver/ 下随 app 发布，不依赖被墙的外部源。
 *
 * 协议：
 *   1) 主页面 new MessageChannel()，port2 → mitm iframe → transfer 给本 SW（见 message 处理）。
 *   2) 本 SW 用一个唯一 url(/streamsaver/<rand>/<name>) 登记「待拦截下载」，
 *      并在同一端口回执 { download: url } 给主页面。
 *   3) 主页面据回执用隐藏 iframe.src=url 触发导航请求 → 命中本 SW fetch 拦截。
 *   4) SW fetch：以一个 ReadableStream 作 attachment 响应体，数据来自主页面在该端口后续
 *      postMessage 的 Uint8Array/ArrayBuffer chunk；收到 'end' 关流，'abort' 报错中断。
 */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

// 待拦截下载：downloadPathname → { stream, headers }
const map = new Map()

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || !data.url) return
  const port = event.ports && event.ports[0]
  if (!port) return

  // 用主页面通过 port 送来的 chunk 喂一个 ReadableStream。
  const stream = new ReadableStream({
    start(controller) {
      port.onmessage = (evt) => {
        const msg = evt.data
        if (msg === 'end') { controller.close(); return }
        if (msg === 'abort') {
          try { controller.error('aborted') } catch (_) {}
          return
        }
        controller.enqueue(msg) // 数据块（Uint8Array / ArrayBuffer）
      }
    },
    cancel() {
      // 浏览器/用户取消下载：通知主页面停止推送。
      try { port.postMessage('cancelled') } catch (_) {}
    },
  })

  const headers = new Headers(data.headers || {})
  headers.set('Content-Type', 'application/octet-stream; charset=utf-8')
  if (!headers.has('Content-Disposition')) {
    const name = encodeURIComponent(data.filename || 'download').replace(/['()]/g, escape)
    headers.set('Content-Disposition', "attachment; filename*=UTF-8''" + name)
  }
  if (typeof data.size === 'number' && data.size >= 0) headers.set('Content-Length', String(data.size))

  let pathname
  try { pathname = new URL(data.url, self.location.origin).pathname } catch (_) { pathname = data.url }
  map.set(pathname, { stream, headers })

  // 回执：把最终下载 url 回给主页面（主页面据此触发导航）。
  port.postMessage({ download: data.url })
})

self.addEventListener('fetch', (event) => {
  let url
  try { url = new URL(event.request.url) } catch (_) { return }
  const hit = map.get(url.pathname)
  if (!hit) return // 非本 SW 负责的下载 URL：放行（不缓存、不干预）
  map.delete(url.pathname)
  event.respondWith(new Response(hit.stream, { headers: hit.headers }))
})
