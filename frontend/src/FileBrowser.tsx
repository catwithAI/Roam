// 文件侧栏 —— 在 Claude / Codex 对话页右侧浏览工作目录、查看文件内容（类似 codex 右侧边栏）。
// 单层可导航列表：目录在前可进入、↑ 回上级、点文件在弹层里查看正文。
import { useEffect, useRef, useState } from 'react'
import { Button, Modal, Spin, App as AntApp, Popconfirm, Tooltip } from 'antd'
import { api, upload } from './api'
import Markdown from './Markdown'

const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']
const MD_EXT = ['md', 'markdown', 'mdx']
function extOf(path: string): string {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

interface Entry { name: string; dir: boolean; size: number }
interface Dir { path: string; parent: string; entries: Entry[] }

function fmtSize(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' K'
  return (n / 1024 / 1024).toFixed(1) + ' M'
}

function joinPath(dir: string, name: string): string {
  return (dir === '/' ? '' : dir) + '/' + name
}

// 目录/文件图标（线性）
const FolderIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
)
const FileIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><polyline points="14 3 14 8 19 8" /></svg>
)
const FolderUpIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 16V10" /><path d="m9 13 3-3 3 3" /></svg>
)
const RefreshIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 1-15 6.7" /><path d="M3 12A9 9 0 0 1 18 5.3" /><path d="M18 2v4h-4" /><path d="M6 22v-4h4" /></svg>
)
const UploadIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M16 16h2a4 4 0 0 0 .7-7.9A6 6 0 0 0 7.4 6.8 5 5 0 0 0 8 16h1" /><path d="M12 18V10" /><path d="m8.5 13.5 3.5-3.5 3.5 3.5" /></svg>
)
const DownloadIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v10" /><path d="m8.5 9.5 3.5 3.5 3.5-3.5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
)
const TrashIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 15H6L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>
)
const EnterIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h12" /><path d="m13 8 4 4-4 4" /><path d="M19 5v14" /></svg>
)
const CloseIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
)
const IconButton = ({ title, children, danger, onClick, disabled, width = 24 }: { title: string; children: React.ReactNode; danger?: boolean; onClick?: (e: React.MouseEvent) => void; disabled?: boolean; width?: number | string }) => (
  <Tooltip title={title}>
    <Button type="text" size="small" disabled={disabled} danger={danger} onClick={(e) => { e.stopPropagation(); onClick?.(e) }}
      style={{ width, height: 24, minWidth: 24, padding: width === 24 ? 0 : '0 6px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
      {children}
    </Button>
  </Tooltip>
)
const Stop = ({ children }: { children: React.ReactNode }) => (
  <span onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>{children}</span>
)

function Viewer({ path, accent, onClose, onDelete }: { path: string; accent: string; onClose: () => void; onDelete: (p: string) => Promise<void> }) {
  const ext = extOf(path)
  const isImg = IMG_EXT.includes(ext)
  const isMd = MD_EXT.includes(ext)
  const rawUrl = `/api/file/raw?path=${encodeURIComponent(path)}`
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState('')
  const [source, setSource] = useState(false) // markdown：源码/渲染切换
  const { message } = AntApp.useApp()

  useEffect(() => {
    if (isImg) return // 图片直接走 <img>，不取文本
    setData(null); setErr(''); setSource(false)
    api('GET', `/file?path=${encodeURIComponent(path)}`).then((r) => setData(r.data)).catch((e) => setErr(e.message))
  }, [path, isImg])

  const name = path.split('/').pop()
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path)
      message.success('已复制路径')
    } catch {
      message.error('复制失败')
    }
  }
  const codePre = (text: string) => (
    <pre style={{ margin: 0, whiteSpace: 'pre', overflow: 'auto', maxHeight: '70vh', background: 'var(--bg-base)', padding: 12, borderRadius: 8, fontFamily: 'ui-monospace, monospace', fontSize: 12.5, lineHeight: 1.5, color: '#c9d1d9' }}>{text}</pre>
  )

  return (
    <Modal open onCancel={onClose} footer={null} width="min(900px,94vw)"
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingRight: 28 }}>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: accent }}>▸</span> {name}
          </span>
          <span style={{ flex: 1 }} />
          {isMd && data && !data.binary && (
            <Button size="small" onClick={() => setSource((s) => !s)}>{source ? '渲染' : '源码'}</Button>
          )}
          <Button size="small" onClick={copyPath}>复制路径</Button>
          <Button size="small" href={`${rawUrl}&dl=1`}>下载</Button>
          <Popconfirm title="删除此文件？" okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
            onConfirm={async () => { await onDelete(path); onClose() }}>
            <Button size="small" danger>删除</Button>
          </Popconfirm>
          <a href={rawUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--text-dim)', fontSize: 12 }}>原始</a>
        </div>
      }>
      {isImg ? (
        <div style={{ textAlign: 'center', background: 'var(--bg-base)', borderRadius: 8, padding: 12 }}>
          <img src={rawUrl} alt={name} style={{ maxWidth: '100%', maxHeight: '74vh', objectFit: 'contain' }} />
        </div>
      ) : (
        <>
          {err && <div style={{ color: '#f85149' }}>{err}</div>}
          {!data && !err && <div style={{ textAlign: 'center', padding: 30 }}><Spin /></div>}
          {data && data.binary && (
            <div style={{ color: 'var(--text-dim)' }}>二进制文件，无法预览（{fmtSize(data.size)}）。<a href={rawUrl} target="_blank" rel="noreferrer" style={{ color: accent }}>下载/打开原始文件</a></div>
          )}
          {data && !data.binary && (
            <>
              {isMd && !source
                ? <div style={{ maxHeight: '70vh', overflow: 'auto' }}><Markdown accent={accent}>{data.content}</Markdown></div>
                : codePre(data.content)}
              {data.truncated && <div style={{ color: '#d29922', fontSize: 12, marginTop: 6 }}>⚠ 文件较大，仅显示前 512 KB</div>}
            </>
          )}
        </>
      )}
    </Modal>
  )
}

export default function FileBrowser({ dir, accent = '#58a6ff', onClose, onInsertPath }: { dir?: string; accent?: string; onClose?: () => void; onInsertPath?: (p: string) => void }) {
  const [path, setPath] = useState(dir || '')
  const [data, setData] = useState<Dir | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<string | null>(null)
  const [tick, setTick] = useState(0) // 上传后强制重载当前目录
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const { message } = AntApp.useApp()

  // 会话切换（dir 变化）→ 回到工作目录根
  useEffect(() => { setPath(dir || '') }, [dir])

  useEffect(() => {
    let stop = false
    setErr('')
    setLoading(true)
    const q = path ? `?path=${encodeURIComponent(path)}` : ''
    api('GET', `/files${q}`)
      .then((r) => { if (!stop) setData(r.data) })
      .catch((e) => { if (!stop) setErr(e.message) })
      .finally(() => { if (!stop) setLoading(false) })
    return () => { stop = true }
  }, [path, tick])

  const cur = data?.path || path
  const refresh = () => setTick((t) => t + 1)
  const goUp = () => { if (data && canUp) setPath(data.parent) }

  const doUpload = async (files: FileList | File[]) => {
    if (!files || !files.length || !cur || uploading) return
    setUploading(true)
    try {
      const res = await upload(cur, files)
      message.success(`已上传 ${res.saved.length} 个文件`)
      refresh()
    } catch (e: any) { message.error('上传失败：' + e.message) }
    finally { setUploading(false) }
  }
  const deletePath = async (target: string) => {
    try {
      const res = await api('DELETE', `/file?path=${encodeURIComponent(target)}`)
      message.success(res.data?.missing ? '文件已不存在，已刷新' : '已删除')
      if (view === target) setView(null)
      refresh()
    } catch (e: any) {
      message.error('删除失败：' + e.message)
      throw e
    }
  }
  // 根目录之上不再回退（防止越过工作目录乱逛；dir 为空时允许一直向上）
  const canUp = !!data && data.parent !== data.path && (!dir || cur !== dir)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0a0e13', borderLeft: '1px solid var(--border-subtle)' }}>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ color: accent }}><FolderIcon /></span>
          <span style={{ color: 'var(--text-bright)', fontWeight: 600, fontSize: 13 }}>文件管理</span>
          <span style={{ flex: 1 }} />
          {onClose && <IconButton title="关闭文件栏" onClick={onClose}><CloseIcon /></IconButton>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <input ref={fileRef} type="file" multiple style={{ display: 'none' }}
            onChange={(e) => { if (e.target.files?.length) doUpload(e.target.files); e.target.value = '' }} />
          <IconButton title="返回上级目录" disabled={!canUp} onClick={goUp}><FolderUpIcon /></IconButton>
          <IconButton title="重新读取当前目录" onClick={refresh}><RefreshIcon /></IconButton>
          <IconButton title="上传到当前目录" disabled={uploading || !cur} onClick={() => fileRef.current?.click()}>{uploading ? '…' : <UploadIcon />}</IconButton>
        </div>
      </div>
      <div title={cur} style={{ padding: '4px 10px', color: 'var(--text-dim)', fontSize: 11.5, fontFamily: 'ui-monospace, monospace', borderBottom: '1px solid var(--bg-container)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left' }}>{cur || '…'}</div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0' }}>
        {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}><Spin size="small" /></div>}
        {err && <div style={{ color: '#f85149', fontSize: 12, padding: '6px 10px' }}>{err}</div>}
        {canUp && (
          <div onClick={goUp} style={rowStyle()}>
            <span style={{ color: 'var(--text-dim)' }}>↑</span><span style={{ color: 'var(--text-dim)' }}>上级目录</span>
          </div>
        )}
        {data?.entries.map((e) => (
          <div key={e.name} className="cc-filerow"
            draggable
            onDragStart={(ev) => {
              const full = joinPath(cur, e.name)
              ev.dataTransfer.setData('application/x-ttmux-path', full) // 给对话框识别用
              ev.dataTransfer.setData('text/plain', full)
              ev.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={() => (e.dir ? setPath(joinPath(cur, e.name)) : setView(joinPath(cur, e.name)))} style={rowStyle()}>
            <span style={{ color: e.dir ? accent : 'var(--text-dimmer)', flex: '0 0 auto', display: 'inline-flex' }}>{e.dir ? <FolderIcon /> : <FileIcon />}</span>
            <span style={{ color: e.dir ? 'var(--text-bright)' : 'var(--text-bright)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
            {!e.dir && <span style={{ color: 'var(--text-dimmer)', fontSize: 11, flex: '0 0 auto' }}>{fmtSize(e.size)}</span>}
            {onInsertPath && (
              <IconButton title="插入路径" onClick={(ev) => { ev.stopPropagation(); onInsertPath(joinPath(cur, e.name)) }}>@</IconButton>
            )}
            {!e.dir && (
              <>
                <Tooltip title="下载">
                  <Button type="text" size="small" href={`/api/file/raw?path=${encodeURIComponent(joinPath(cur, e.name))}&dl=1`}
                    onClick={(ev) => ev.stopPropagation()}
                    style={{ width: 24, height: 24, minWidth: 24, padding: 0, color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><DownloadIcon /></Button>
                </Tooltip>
              </>
            )}
            <Popconfirm title={e.dir ? '删除此空目录？' : '删除此文件？'} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
              onConfirm={() => deletePath(joinPath(cur, e.name))}>
              <Stop>
                <Button type="text" size="small" danger
                  style={{ width: 24, height: 24, minWidth: 24, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><TrashIcon /></Button>
              </Stop>
            </Popconfirm>
            {e.dir && (
              <IconButton title="进入目录" onClick={(ev) => { ev.stopPropagation(); setPath(joinPath(cur, e.name)) }}><EnterIcon /></IconButton>
            )}
          </div>
        ))}
        {data && data.entries.length === 0 && <div style={{ color: 'var(--text-dimmer)', fontSize: 12, padding: '6px 10px' }}>空目录</div>}
      </div>
      {view && <Viewer path={view} accent={accent} onClose={() => setView(null)} onDelete={deletePath} />}
    </div>
  )
}

function rowStyle(): React.CSSProperties {
  return { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 13, userSelect: 'none' }
}
