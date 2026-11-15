/**
 * DSH-memory-ACC — slice 1: keep the complete conversation.
 *
 * The session log on disk is the only source of truth, so the archive is derived
 * from it rather than captured in parallel: a log is a sequence of zstd FRAMES
 * (one per flush), which is why a single decompress call yields only the header.
 * Every frame has to be decoded.
 *
 * Nothing here invents a session event type: an unknown stored event makes the
 * session refuse to reopen, so ACC keeps its own files and never writes the log.
 */

/** chmod 是 POSIX 语义；Windows 上可能抛 EPERM，所以做成尽力而为。 */
function safeChmod(target, mode) {
  try { chmodSync(target, mode) } catch { /* 平台不适用就当成功 */ }
}
import { homedir } from 'node:os'
import { appendFileSync, chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import * as zlib from 'node:zlib'
import { join, dirname } from 'node:path'
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, createHash } from 'node:crypto'

export const name = 'dsh-memory-acc'
export const inject = ['tools', 'webServer', 'llm', 'systemPrompt']

const LOG_NAME = 'session.v4.jsonl.zstd'
const FALLBACK_LOG = 'session.v3.jsonl.zstd'

/** The conversational event types worth keeping verbatim. */
const KEEP = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'system/message', 'developer/message'])

function home() {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

function accRoot() {
  // Default INSIDE DSH_HOME, not next to it: otherwise the lab instance would write
  // into the shared home and two instances would silently share one archive.
  if (process.env.DSH_ACC_HOME !== undefined && process.env.DSH_ACC_HOME.length > 0) return process.env.DSH_ACC_HOME
  return join(home(), 'acc')
}

/**
 * Decode every zstd frame in a session log. Prefers the in-process stream (which
 * walks concatenated frames) and falls back to the zstd binary when this Node
 * build has no zstd support at all.
 */
function decodeLog(path) {
  // Proven order: the zstd CLI walks every frame of a multi-frame append log.
  // The in-process stream is only a fallback, because a partial decode silently
  // yields just the header event and looks like "the session was empty".
  // Windows 通常没有 zstd 命令行：先试，缺了不报错，交给 node 流兜底
  let cli = { status: null, stdout: Buffer.alloc(0), stderr: '' }
  if (process.platform !== 'win32') {
    try { cli = spawnSync('zstd', ['-dc', path], { maxBuffer: 512 * 1024 * 1024 }) } catch { /* 没有就没有 */ }
  }
  if (cli.status === 0 && cli.stdout.length > 0) return { text: cli.stdout.toString('utf8'), how: 'zstd-cli' }
  if (typeof zlib.createZstdDecompress === 'function') {
    const child = spawnSync(process.execPath, ['-e', [
      'const fs=require("node:fs"),z=require("node:zlib");const out=[];',
      'fs.createReadStream(process.argv[1]).pipe(z.createZstdDecompress())',
      '.on("data",c=>out.push(c))',
      '.on("end",()=>process.stdout.write(Buffer.concat(out)))',
      '.on("error",e=>{console.error(e.message);process.exit(1)})'
    ].join(''), path], { maxBuffer: 512 * 1024 * 1024 })
    if (child.status === 0 && child.stdout.length > 0) return { text: child.stdout.toString('utf8'), how: 'node-stream' }
    throw new Error('decode failed: cli=' + String(cli.stderr ?? '').slice(0, 120) + ' stream=' + String(child.stderr ?? '').slice(0, 120))
  }
  throw new Error('cannot decode session log: no zstd available')
}

/** Every image attachment id in a message, in order. */
function imageIds(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return []
  const out = []
  for (const block of message.content) {
    if (block === null || typeof block !== 'object' || block.type !== 'image') continue
    const id = String(block.attachment?.attachmentId ?? block.attachmentId ?? '')
    if (id.length > 0) out.push(id)
  }
  return out
}

/** One line of readable text for any content block. */
function blockText(block) {
  if (block === null || typeof block !== 'object') return ''
  switch (block.type) {
    case 'text': return String(block.text ?? '')
    case 'reasoning': return ''
    case 'tool-call': return '[调用 ' + String(block.name ?? '?') + '] ' + JSON.stringify(block.arguments ?? block.input ?? {})
    case 'image': return '[图片 ' + String(block.attachment?.attachmentId ?? block.attachmentId ?? '?') + ']'
    case 'file': return '[文件 ' + String(block.attachment?.name ?? '?') + ']'
    default: return ''
  }
}

/** Normalise one stored event into an archive record, or null when not kept. */
function toRecord(event) {
  if (event === null || typeof event !== 'object') return null
  const type = String(event.type ?? '')
  const at = typeof event.time === 'number' ? new Date(event.time).toISOString() : ''
  const data = event.data ?? {}

  if (type === 'user/message') {
    const message = data.message ?? data
    const text = Array.isArray(message.content) ? message.content.map(blockText).filter(Boolean).join('\n') : String(message.text ?? '')
    return { seq: event.seq, at, role: 'user', kind: 'message', text, images: imageIds(message) }
  }
  if (type === 'assistant/message') {
    const message = data.message ?? data
    const text = Array.isArray(message.content) ? message.content.map(blockText).filter(Boolean).join('\n') : ''
    return { seq: event.seq, at, role: 'assistant', kind: 'message', text, images: imageIds(message) }
  }
  if (type === 'tool/call') {
    return { seq: event.seq, at, role: 'tool', kind: 'call', text: String(data.name ?? data.toolName ?? '?') + ' ' + JSON.stringify(data.arguments ?? {}) }
  }
  if (type === 'tool/result') {
    const content = Array.isArray(data.content) ? data.content.map(blockText).filter(Boolean).join('\n') : String(data.text ?? '')
    return { seq: event.seq, at, role: 'tool', kind: 'result', text: content }
  }
  if (type === 'system/message' || type === 'developer/message') {
    const message = data.message ?? data
    const text = Array.isArray(message.content) ? message.content.map(blockText).filter(Boolean).join('\n') : ''
    return { seq: event.seq, at, role: type.startsWith('system') ? 'system' : 'developer', kind: 'message', text }
  }
  return null
}

/** Every session directory under DSH_HOME/sessions, newest first. */
function listSessions() {
  const root = join(home(), 'sessions')
  if (!existsSync(root)) return []
  const found = []
  for (const workspace of readdirSync(root)) {
    const wsDir = join(root, workspace)
    if (!statSync(wsDir).isDirectory()) continue
    for (const session of readdirSync(wsDir)) {
      const dir = join(wsDir, session)
      let info = null
      try { info = statSync(dir) } catch { continue }
      if (!info.isDirectory()) continue
      const log = existsSync(join(dir, LOG_NAME)) ? join(dir, LOG_NAME) : (existsSync(join(dir, FALLBACK_LOG)) ? join(dir, FALLBACK_LOG) : null)
      if (log === null) continue
      found.push({ workspace, session, dir, log, bytes: statSync(log).size, mtime: info.mtimeMs })
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)
}

function readLine(path) {
  try { return readFileSync(path, 'utf8').trim() } catch { return '' }
}



// --- engine handshake -------------------------------------------------------
// Two memory engines in one profile means two memory chains per turn: duplicated
// cost and, once both inject context, a fight over the prompt. Each engine signs
// itself into a process-wide table and scans it; seeing a second signature is the
// only evidence of a duplicate install there is. A shared table beats a heartbeat
// file because the host process is the shared thing, and beats HTTP because every
// route sits behind the browser-trust fence.
// 版本号只写在一个地方：package.json。握手表里露出的版本曾长期停在 0.1.0，
// 于是「二选一」弹窗里显示的是 ACC v0.1.0 —— 对用户来说那就是个假版本号。
const VERSION = (() => {
  try { return String(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '0.0.0') } catch { return '0.0.0' }
})()
const ENGINE_ID = 'dsh-memory-acc'
// 「工具到底注册上没有」只有 apply 当时知道，事后靠冲突表反推会撒谎：
// 把另一个引擎停用之后冲突已经为 0，但 ACC 这轮并没有注册过工具（apply 只跑一次）。
let ACC_TOOLS_REGISTERED = false
const REGISTRY = Symbol.for('dsh.memory.engines')

function engines() {
  if (globalThis[REGISTRY] === undefined) globalThis[REGISTRY] = {}
  return globalThis[REGISTRY]
}

function engineList() {
  return Object.entries(engines()).map(([id, info]) => ({ id, kind: info.kind, version: info.version, at: info.at }))
}

// 谁装在这个 profile 里，patch 上是静态可读的；握手表只说明「谁已经 apply 过」，
// 而两个插件谁先 apply 不确定 —— 按表判断，结果就取决于启动顺序。所以冲突看 patch。
const MEMORY_IDS = { 'dsh-memory': 'memory', memory: 'memory', 'dsh-memory-acc': 'acc', 'memory-acc': 'acc' }

/** 这一行属于哪个列表项（最近的、缩进更浅的 "- " 行）。 */
function rowStart(lines, index) {
  if (/^\s*-\s/.test(lines[index])) return index
  const indent = lines[index].length - lines[index].trimStart().length
  for (let k = index - 1; k >= 0; k -= 1) {
    if (!/^\s*-\s/.test(lines[k])) continue
    if (lines[k].length - lines[k].trimStart().length < indent) return k
  }
  return index
}

/**
 * The memory engines the profile patch leaves enabled, or null when the patch is
 * unreadable. Line-based on purpose: the patch is hand-written YAML with comments,
 * and one boolean per engine is all that is needed here.
 */
function readProfileEngines() {
  const dir = process.env.DSH_PROFILE_DIR ?? ''
  if (dir.length === 0) return null
  let raw = ''
  try { raw = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8') } catch { return null }
  const lines = raw.split('\n')
  const state = { memory: false, acc: false }
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*-\s*(?:id|name):\s*["']?([A-Za-z0-9._-]+)["']?\s*$/.exec(lines[i])
    if (m === null) continue
    const kind = MEMORY_IDS[m[1]]
    if (kind === undefined) continue
    const start = rowStart(lines, i)
    const indent = lines[start].length - lines[start].trimStart().length
    let disabled = false
    for (let j = start + 1; j < lines.length; j += 1) {
      const next = lines[j]
      if (next.trim().length === 0) continue
      if (next.length - next.trimStart().length <= indent) break
      if (/^\s*disabled:\s*(true|yes)\s*$/.test(next)) disabled = true
    }
    if (!disabled) state[kind] = true
  }
  return state
}

/**
 * Switch the other engine off by rewriting the profile patch. Parsed and
 * re-serialised, never string-appended: appending to an existing list is how a
 * profile patch grows two top-level nodes and the app stops booting.
 */
/** Read or change where files go and whether they are sealed. The key is never echoed. */
async function configRoute(req, res) {
  const url = new URL(req.url, 'http://local')
  if (req.method !== 'POST') {
    const config = readAccConfig()
    return sendJson(res, 200, {
      root: config.root, encrypt: config.encrypt,
      effectiveRoot: dataRoot(), hasKey: accKey().length > 0,
      home: accHome(), resident: readAccConfig().resident ?? '', residentDir: readAccConfig().residentDir ?? '', residentWs: readAccConfig().residentWs ?? '', mode: readMode()
    })
  }
  const rootArg = url.searchParams.get('root')
  const encryptArg = url.searchParams.get('encrypt')
  const keyArg = url.searchParams.get('key')
  const residentArg = url.searchParams.get('resident')
  const residentDirArg = url.searchParams.get('residentDir')
  const residentWsArg = url.searchParams.get('residentWs')
  const backupRootArg = url.searchParams.get('backupRoot')
  const patch = {}
  if (residentArg !== null) patch.resident = residentArg.trim()
  if (residentDirArg !== null) patch.residentDir = residentDirArg.trim()
  if (residentWsArg !== null) patch.residentWs = residentWsArg.trim()
  if (backupRootArg !== null) patch.backupRoot = backupRootArg.trim()
  if (rootArg !== null) patch.root = rootArg.trim()
  if (encryptArg !== null) patch.encrypt = encryptArg === '1' || encryptArg === 'true'
  if (keyArg !== null) {
    try {
      if (keyArg.trim().length === 0) { if (existsSync(keyFile())) unlinkSync(keyFile()) }
      else { mkdirSync(accHome(), { recursive: true }); writeFileSync(keyFile(), keyArg.trim() + '\n', { mode: 0o600 }) }
    } catch (error) { return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
  }
  const next = writeAccConfig(patch)
  return sendJson(res, 200, { ok: true, root: next.root, encrypt: next.encrypt, effectiveRoot: dataRoot(), hasKey: accKey().length > 0, resident: next.resident ?? '' })
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Does the parsed patch list carry `disabled: true` on the entry whose id or name is target? */
function listHasDisabled(list, target) {
  for (const entry of (Array.isArray(list) ? list : [])) {
    const rows = Array.isArray(entry?.insert) ? entry.insert : []
    for (const row of rows) if ((row?.id === target || row?.name === target) && row.disabled === true) return true
    if ((entry?.id === target || entry?.name === target) && entry.disabled === true) return true
  }
  return false
}

/**
 * Add `disabled: true` by inserting exactly one line, leaving every other byte
 * (including the comments the user wrote) alone: a full YAML round-trip silently
 * drops comments, and this file is hand-annotated.
 * Returns { text, already } or null when no row matches.
 */
function insertDisabledLine(raw, target) {
  if (target.length === 0) return null
  const pattern = new RegExp('^(\\s*)(-\\s+)?(?:id|name):\\s*' + escapeRe(target) + '\\s*$')
  const lines = raw.split('\n')
  const out = []
  let hit = false
  let already = false
  let i = 0
  while (i < lines.length) {
    const m = /^(\s*)-(\s+)/.exec(lines[i])
    if (m === null) { out.push(lines[i]); i += 1; continue }
    const dashIndent = m[1].length
    let j = i + 1
    while (j < lines.length) {
      const next = lines[j]
      if (next.trim().length === 0) { j += 1; continue }
      if (next.length - next.trimStart().length <= dashIndent) break
      j += 1
    }
    let inserted = false
    for (let k = i; k < j; k += 1) {
      out.push(lines[k])
      const hitLine = pattern.exec(lines[k])
      if (hitLine === null) continue
      hit = true
      // 一行里 id 和 name 都等于目标时（id === name 很常见）只能插一次，
      // 否则会写出两个 disabled: true —— YAML 能过，但读起来像手抖。
      if (inserted) continue
      // 键的列 = "- " 之后那一列；插在同一列才是兄弟键，不是父级键。
      const keyIndent = hitLine[1].length + (hitLine[2] === undefined ? 0 : hitLine[2].length)
      const row = lines.slice(i, j)
      if (row.some((l) => /^\s*disabled:\s*true\s*$/.test(l))) { already = true; inserted = true; continue }
      out.push(' '.repeat(keyIndent) + 'disabled: true')
      inserted = true
    }
    i = j
  }
  if (!hit) return null
  return { text: out.join('\n'), already }
}

async function disableOther(ctx, req, res) {
  const url = new URL(req.url, 'http://local')
  const target = String(url.searchParams.get('target') ?? '').trim()
  const dir = process.env.DSH_PROFILE_DIR ?? ''
  if (dir.length === 0) return sendJson(res, 400, { ok: false, error: 'DSH_PROFILE_DIR is not set; cannot locate the profile patch' })
  const file = join(dir, 'cordis.patch.yml')
  if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: 'no cordis.patch.yml in ' + dir })
  let YAML
  try { YAML = await import('yaml') } catch (error) { return sendJson(res, 500, { ok: false, error: 'yaml unavailable: ' + String(error?.message ?? error) }) }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  try {
    const raw = readFileSync(file, 'utf8')
    const edited = insertDisabledLine(raw, target)
    if (edited !== null) {
      if (edited.already) return sendJson(res, 200, { ok: true, disabled: target, file, note: 'already disabled' })
      let parsed = null
      try { parsed = YAML.parse(edited.text) } catch (error) { return sendJson(res, 500, { ok: false, error: 'refused, the edit would break the patch: ' + String(error?.message ?? error) }) }
      if (!listHasDisabled(parsed, target)) return sendJson(res, 500, { ok: false, error: 'refused, the edit did not set disabled on ' + target })
      writeFileSync(file + '.bak-' + stamp, raw)
      writeFileSync(file, edited.text)
      return sendJson(res, 200, { ok: true, disabled: target, file, note: 'one line added, comments kept; HMR reconciles patch edits live' })
    }
    // 罕见写法（flow style 等）退回整份重写：能改，但注释会丢，所以先留备份。
    const doc = YAML.parse(raw) ?? []
    const list = Array.isArray(doc) ? doc : []
    let changed = false
    for (const entry of list) {
      const rows = Array.isArray(entry?.insert) ? entry.insert : []
      for (const row of rows) {
        const hit = row?.id === target || row?.name === target
        if (!hit) continue
        row.disabled = true
        changed = true
      }
      if (entry?.id === target || entry?.name === target) { entry.disabled = true; changed = true }
    }
    if (!changed) return sendJson(res, 200, { ok: false, error: 'target not found: ' + target })
    writeFileSync(file + '.bak-' + stamp, raw)
    writeFileSync(file, YAML.stringify(list))
    return sendJson(res, 200, { ok: true, disabled: target, file, note: 'rewritten as a whole, comments are not preserved' })
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
}


// --- configuration ----------------------------------------------------------
// Where archives and backups live, and whether they are sealed. Unencrypted is
// the default on purpose: a memory engine that refuses to start because a key is
// missing is worse than one that stores readable files on a machine you own. The
// key file is never returned by any route.
function accHome() {
  return accRoot()
}

function configFile() {
  return join(accHome(), 'config.json')
}

function keyFile() {
  return join(accHome(), 'secret')
}

function readAccConfig() {
  // Keep every field: this used to narrow to {root, encrypt}, which silently threw
  // away resident/mode on the way back in — the value was written and then lost.
  try {
    const parsed = JSON.parse(readFileSync(configFile(), 'utf8'))
    return {
      ...(parsed !== null && typeof parsed === 'object' ? parsed : {}),
      root: typeof parsed.root === 'string' ? parsed.root : '',
      encrypt: parsed.encrypt === true
    }
  } catch {
    return { root: '', encrypt: false }
  }
}

function writeAccConfig(patch) {
  const next = { ...readAccConfig(), ...patch }
  mkdirSync(dirname(configFile()), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

function dataRoot() {
  const config = readAccConfig()
  return config.root.length > 0 ? config.root : join(accHome(), 'conversations')
}

function accKey() {
  const fromEnv = process.env.DSH_ACC_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  try { return readFileSync(keyFile(), 'utf8').trim() } catch { return '' }
}

function seal(buffer, password) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(password, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(buffer), cipher.final()])
  return Buffer.concat([Buffer.from('ACC1'), salt, iv, cipher.getAuthTag(), body])
}

function unseal(buffer, password) {
  const salt = buffer.subarray(4, 20)
  const iv = buffer.subarray(20, 32)
  const tag = buffer.subarray(32, 48)
  const key = scryptSync(password, salt, 32)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(buffer.subarray(48)), decipher.final()])
}


// --- S3: search + the engine switch -----------------------------------------
const MODES = ['memory', 'acc', 'off']

function readMode() {
  try { const m = JSON.parse(readFileSync(configFile(), 'utf8')).mode; return MODES.includes(m) ? m : 'acc' } catch { return 'acc' }
}
function writeMode(mode) {
  if (!MODES.includes(mode)) throw new Error('mode must be one of ' + MODES.join(', '))
  writeAccConfig({ mode })
  return mode
}

/** Every archived conversation, newest first. Sealed ones are skipped without a key. */
function archivedSessions(limit) {
  const root = dataRoot()
  if (!existsSync(root)) return []
  const out = []
  for (const workspace of readdirSync(root)) {
    const wsDir = join(root, workspace)
    let isDir = false
    try { isDir = statSync(wsDir).isDirectory() } catch { continue }
    if (!isDir) continue
    for (const session of readdirSync(wsDir)) {
      const dir = join(wsDir, session)
      const plain = join(dir, 'conversation.jsonl')
      const sealed = join(dir, 'conversation.jsonl.acc')
      out.push({ workspace, session, dir, plain: existsSync(plain), sealed: existsSync(sealed) })
    }
  }
  return out.slice(0, limit === undefined ? 40 : limit)
}

/** Read one archived conversation as text; sealed files need the configured key. */
function readArchive(entry) {
  if (entry.plain) return readFileSync(join(entry.dir, 'conversation.jsonl'), 'utf8')
  if (entry.sealed) {
    const password = accKey()
    if (password.length === 0) return ''
    try { return unseal(readFileSync(join(entry.dir, 'conversation.jsonl.acc')), password).toString('utf8') } catch { return '' }
  }
  return ''
}

/**
 * Search the archive the way a person remembers: by a handful of words, not by
 * the exact phrase. Returns the session it came from so the caller can pull more.
 */
function searchArchives(query, limit) {
  const words = tokensOf(query)
  if (words.length === 0) return []
  const hits = []
  for (const entry of archivedSessions(40)) {
    const text = readArchive(entry)
    if (text.length === 0) continue
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let record
      try { record = JSON.parse(line) } catch { continue }
      const body = String(record.text ?? '')
      if (body.length === 0) continue
      const lower = body.toLowerCase()
      let score = 0
      for (const word of words) if (lower.includes(word)) score += 1
      if (score > 0) hits.push({ score, session: entry.session, role: record.role, at: record.at, text: body })
    }
  }
  hits.sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)))
  return hits.slice(0, limit === undefined ? 12 : limit)
}

/** Split a query into words: spaces, commas, slashes and full-width punctuation. */
function tokensOf(text) {
  const parts = String(text ?? "").toLowerCase()
    .split(/[\s,，、/|;；:：()（）"']+/)
    .map(function (word) { return word.trim() })
    .filter(function (word) { return word.length >= 2 })
  const unique = Array.from(new Set(parts))
  if (unique.length > 0) return unique
  const whole = String(text ?? "").trim().toLowerCase()
  return whole.length > 0 ? [whole] : []
}

// --- 恍惚：会自己浮上来的记忆 ------------------------------------------------
// 大多数记忆是"被问才想起"。人不是这样：偶尔有件事会自己冒出来，和当下未必相关。
// 这就是恍惚——不是检索，是浮现。它必须稀有，否则就是噪声。
const VIVID_CHANCE = 0.03          // 每次检索 3% 概率触发
const VIVID_PER_DAY = 2            // 每 24 小时最多 2 次
const VIVID_CAP = 60               // 权重淘汰的上限
const VIVID_KINDS = ['interesting', 'awkward']

function vividFile() {
  return join(accHome(), 'vivid.json')
}

function readVivid() {
  try {
    const parsed = JSON.parse(readFileSync(vividFile(), 'utf8'))
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries.filter(function (e) { return e !== null && typeof e === 'object' && typeof e.text === 'string' }) : [],
      surfacedAt: Array.isArray(parsed.surfacedAt) ? parsed.surfacedAt.filter(function (t) { return typeof t === 'number' }) : []
    }
  } catch { return { entries: [], surfacedAt: [] } }
}

function writeVivid(next) {
  mkdirSync(accHome(), { recursive: true })
  writeFileSync(vividFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

/**
 * 整理曲线参考备份金字塔，但排序依据换成"被调用权重优先，其次最新"。
 * 一条从没被想起过的记忆，比一条反复浮现的更该被淘汰。
 */
function consolidateVivid(state) {
  const sorted = state.entries.slice().sort(function (a, b) {
    const wa = typeof a.calls === 'number' ? a.calls : 0
    const wb = typeof b.calls === 'number' ? b.calls : 0
    if (wa !== wb) return wb - wa
    return String(b.at ?? '').localeCompare(String(a.at ?? ''))
  })
  return sorted.slice(0, VIVID_CAP)
}

function addVivid(kind, text) {
  if (!VIVID_KINDS.includes(kind)) throw new Error('kind must be interesting or awkward')
  const clean = String(text ?? '').trim().slice(0, 240)
  if (clean.length === 0) throw new Error('text is required')
  const state = readVivid()
  const entries = state.entries.filter(function (e) { return e.text !== clean })
  entries.push({ id: entries.length + 1, kind, text: clean, at: new Date().toISOString(), calls: 0 })
  return writeVivid({ surfacedAt: state.surfacedAt, entries: consolidateVivid({ entries }) })
}

/**
 * 也许浮现一条。返回一行提示，或空串。
 * 三个约束叠在一起：概率低、次数有上限、最近浮现过的短期内不再来。
 */
function maybeSurfaceVivid() {
  const state = readVivid()
  if (state.entries.length === 0) return ''
  const dayAgo = Date.now() - 86400000
  const recent = state.surfacedAt.filter(function (t) { return t > dayAgo })
  if (recent.length >= VIVID_PER_DAY) return ''
  if (Math.random() >= VIVID_CHANCE) return ''
  const picked = state.entries.slice().sort(function (a, b) {
    const wa = typeof a.calls === 'number' ? a.calls : 0
    const wb = typeof b.calls === 'number' ? b.calls : 0
    return wb - wa
  })[0]
  if (picked === undefined) return ''
  picked.calls = (typeof picked.calls === 'number' ? picked.calls : 0) + 1
  writeVivid({ entries: state.entries, surfacedAt: recent.concat([Date.now()]) })
  const label = picked.kind === 'awkward' ? '有点尴尬的事' : '有意思的事'
  return '（忽然想起一件' + label + '，和现在未必有关：' + oneLine(picked.text) + '）\n'
}

// --- deep memory: the conclusions, not the character ---------------------------
// Persona says what someone is like. This says what was settled — the decisive
// findings that should survive every session. Small on purpose: if it grows past
// a screenful it stops being memory and becomes a filing cabinet.
const DEEP_CAP = 80

function deepFile() {
  return join(accHome(), 'deep.json')
}

function readDeep() {
  try {
    const parsed = JSON.parse(readFileSync(deepFile(), 'utf8'))
    return {
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      facts: Array.isArray(parsed.facts) ? parsed.facts.filter(function (f) { return f !== null && typeof f === 'object' && typeof f.text === 'string' }) : []
    }
  } catch { return { updatedAt: '', facts: [] } }
}

function writeDeep(next) {
  mkdirSync(accHome(), { recursive: true })
  writeFileSync(deepFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

/** Add one conclusion; the newest wins and duplicates collapse. */
function addDeepFact(text) {
  const clean = String(text ?? '').trim().slice(0, 300)
  if (clean.length === 0) throw new Error('text is required')
  const current = readDeep()
  const facts = current.facts.filter(function (f) { return f.text !== clean })
  facts.push({ id: facts.length + 1, text: clean, at: new Date().toISOString() })
  const trimmed = facts.slice(-DEEP_CAP)
  return writeDeep({ updatedAt: new Date().toISOString(), facts: trimmed })
}

// --- context injection --------------------------------------------------------
// Without this the archive is write-only: a fresh session knows nothing, so every
// new workspace feels like meeting a stranger again. Inject the impression, keep
// it short, and say where the depth lives.
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function clipText(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : value.slice(0, max - 1) + '…'
}

/** The memory block for one assembly. Deterministic, local, no model call. */
function accContextText(context) {
  const mode = readMode()
  if (mode === 'off') return ''
  // 装配这一刻再判断，而不是加载那一刻：ACC 通常先加载，那时表里只有它自己。
  // 另一个引擎在场时让位——两段记忆同时注入等于每轮付双倍 token。
  const others = engineList().filter(function (e) { return e.id !== ENGINE_ID })
  if (others.length > 0) return ''
  const persona = readPersona()
  const perFacet = mode === 'memory' ? 1 : 2
  const lines = []
  for (const subject of SUBJECTS) {
    const parts = []
    for (const facet of FACETS) {
      const list = persona[subject][facet]
      if (!Array.isArray(list) || list.length === 0) continue
      parts.push(FACET_LABEL[facet] + '：' + list.slice(-perFacet).map(oneLine).join('；'))
    }
    if (parts.length > 0) lines.push((subject === 'you' ? '你' : '我') + ' —— ' + parts.join(' · '))
  }
  const deep = readDeep()
  const deepLines = deep.facts.slice(-6).map(function (f) { return '· ' + oneLine(f.text) })
  // 做梦留下的余味：每人设梦一句，最多三句。故事本身不进上下文，进的是这一句。
  const essences = readEssence(3).map(function (one) { return '· ' + oneLine(one.essence) })
  if (lines.length === 0 && deepLines.length === 0 && essences.length === 0) return ''
  const parts = []
  if (lines.length > 0) parts.push(lines.join('\n'))
  if (deepLines.length > 0) parts.push('已定下的结论：\n' + deepLines.join('\n'))
  if (essences.length > 0) parts.push('梦的余味（你自己整理记忆时写下的，不是此刻的想法）：\n' + essences.join('\n'))
  const body = '记忆（ACC）：这些是印象，不是档案条文。\n' + parts.join('\n')
    + '\n需要更早的具体内容时用 acc_search 或 memory_read 去找，别凭印象编；找不到就说没有印象。'
  // A stray {{ would be read as an interpolation reference and throw during assembly.
  return clipText(body, 1100).replaceAll('{{', '{ {')
}

// --- S2: the 4D persona ------------------------------------------------------
// Eight facets per person, and TWO people: what the model makes of the human, and
// what it makes of itself. Both are written as the model's own subjective read —
// that is the point of ACC — but every line has an owner, so one voice never
// masquerades as the other.
const FACETS = ["temper", "mouth", "affinity", "habits", "likes", "manner", "style", "ability"]
const FACET_LABEL = {
  temper: "性格", mouth: "口吻", affinity: "好感", habits: "习惯",
  likes: "喜欢的物品", manner: "习惯的作风", style: "风格", ability: "能力"
}
const SUBJECTS = ["you", "me"]

function emptyFacets() {
  const out = {}
  for (const facet of FACETS) out[facet] = []
  return out
}

function personaFile() {
  return join(accHome(), "persona.json")
}

function readPersona() {
  const blank = { updatedAt: "", you: emptyFacets(), me: emptyFacets() }
  let parsed = null
  try { parsed = JSON.parse(readFileSync(personaFile(), "utf8")) } catch { return blank }
  if (parsed === null || typeof parsed !== "object") return blank
  // A flat file from before the split is folded into "you": that is who it described.
  const flat = FACETS.some(function (facet) { return Array.isArray(parsed[facet]) })
  const out = { updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "", you: emptyFacets(), me: emptyFacets() }
  for (const subject of SUBJECTS) {
    const source = flat && subject === "you" ? parsed : (parsed[subject] ?? {})
    for (const facet of FACETS) out[subject][facet] = Array.isArray(source[facet]) ? source[facet] : []
  }
  return out
}

function writePersona(next) {
  mkdirSync(accHome(), { recursive: true })
  writeFileSync(personaFile(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
  return next
}

/** Add one line to one facet of one subject. */
function addFacet(persona, subject, facet, text) {
  if (!SUBJECTS.includes(subject)) throw new Error("subject must be you or me")
  if (!FACETS.includes(facet)) throw new Error("facet must be one of " + FACETS.join(", "))
  const next = { ...persona, updatedAt: new Date().toISOString(), you: { ...persona.you }, me: { ...persona.me } }
  const list = Array.isArray(next[subject][facet]) ? next[subject][facet].slice() : []
  if (text.length > 0 && list.indexOf(text) < 0) list.push(text)
  next[subject][facet] = list.slice(-12)
  return next
}

/** Merge model output (already shaped {you:{…},me:{…}}) into what is stored. */
function mergePersona(previous, incoming) {
  const next = { updatedAt: new Date().toISOString(), you: {}, me: {} }
  for (const subject of SUBJECTS) {
    for (const facet of FACETS) {
      const before = Array.isArray(previous[subject][facet]) ? previous[subject][facet] : []
      const raw = incoming !== null && typeof incoming === "object" ? incoming[subject] : undefined
      const fresh = raw !== undefined && Array.isArray(raw[facet])
        ? raw[facet].filter(function (v) { return typeof v === "string" && v.trim().length > 0 }).map(function (v) { return v.trim().slice(0, 120) })
        : []
      const merged = []
      for (const item of fresh.concat(before)) if (merged.indexOf(item) < 0) merged.push(item)
      next[subject][facet] = merged.slice(0, 12)
    }
  }
  return next
}

/**
 * Ask the harness model to read a stretch of conversation and say what it makes of
 * the two people in it. Subjective on purpose; the ownership is what keeps it usable.
 */
async function distill(llm, text) {
  const system = [
    "你要从一段真实对话里描摹两个人：对话里的人类，和你自己（模型这一侧）。",
    "以你的主观印象写，不需要客观，也不要美化；只写你确实从这段对话里看到的。",
    "两条规则：",
    "1. 关于人类的话放进 you，关于你自己的话放进 me，不要混。",
    "2. 每面是一个字符串数组，每条不超过 40 字；没有内容就给空数组。",
    "面名：" + JSON.stringify(FACET_LABEL),
    '只输出 JSON，形如 {"you":{...},"me":{...}}，不要解释。'
  ].join("\n")
  const messages = [{ role: "user", content: [{ type: "text", text: system + "\n\n对话：\n" + text.slice(0, 12000) }] }]
  const said = []
  for await (const chunk of llm.stream({ provider: "deepseek-official", model: "deepseek-flash", messages, maxTokens: 4000 })) {
    if (chunk !== null && typeof chunk === "object" && chunk.type === "text-delta") said.push(String(chunk.text ?? ""))
  }
  const raw = said.join("")
  const first = raw.indexOf("{")
  const last = raw.lastIndexOf("}")
  if (first < 0 || last <= first) return { __raw: raw.slice(0, 400), __chars: raw.length }
  try { return JSON.parse(raw.slice(first, last + 1)) } catch { return { __raw: raw.slice(0, 400), __chars: raw.length } }
}

// --- S5: 做梦 -----------------------------------------------------------------
// 记忆不整理就会变成噪声：性格档越写越长，每一条都在抢同一段注入预算；二级记忆
// 越攒越像文件柜；恍惚里的旧事也早就不该再冒出来。整理不等于删除——退下来的条目
// 全部进 history，随时查得到。
//
// 频率不排班，掷色子：每天掷一次，本周还欠几次就越容易中；欠到日子不够了直接做实。
// 这样一周至少两次，但不机械，也不会在同一个钟点扎堆。
const DREAM_TARGET = 2
const DREAM_MIN_GAP_MS = 8 * 3600 * 1000
const DREAM_TICK_MS = 5 * 60 * 1000
const DREAM_KEEP_PER_FACET = 4
const DREAM_DEEP_KEEP = 20
const DREAM_ESSENCE_KEEP = 24
const DREAM_ESSENCE_MAX = 26
const VIVID_RETIRE_DAYS = 90
const DAY_MS = 86400000

let DREAM_RUNNING = false

function dreamsRoot() {
  return join(accHome(), 'dreams')
}

function dreamStateFile() {
  return join(dreamsRoot(), 'state.json')
}

function readDreamState() {
  const blank = { week: '', count: 0, carry: 0, lastAt: '', rolledDay: '', fireAt: 0, failures: 0, lastError: '' }
  try {
    const parsed = JSON.parse(readFileSync(dreamStateFile(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return blank
    return {
      week: typeof parsed.week === 'string' ? parsed.week : '',
      count: typeof parsed.count === 'number' && parsed.count >= 0 ? Math.floor(parsed.count) : 0,
      carry: parsed.carry === 1 ? 1 : 0,
      lastAt: typeof parsed.lastAt === 'string' ? parsed.lastAt : '',
      rolledDay: typeof parsed.rolledDay === 'string' ? parsed.rolledDay : '',
      fireAt: typeof parsed.fireAt === 'number' ? parsed.fireAt : 0,
      failures: typeof parsed.failures === 'number' ? parsed.failures : 0,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : ''
    }
  } catch { return blank }
}

function writeDreamState(next) {
  ensureDir(dreamsRoot())
  writeFileSync(dreamStateFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

/** 本周从本地周一 00:00 起算；标签用 ISO 周，和备份金字塔同一套说法。 */
function dreamWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const shift = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - shift)
  const noon = new Date(start.getTime() + 12 * 3600 * 1000)
  const end = new Date(start.getTime())
  end.setDate(end.getDate() + 7)
  return { label: isoWeekStamp(noon), start: start.getTime(), end: end.getTime() }
}

function dreamStamp(at) {
  return String(at ?? '').replace(/[:.]/g, '-')
}

function essenceFile() {
  return join(dreamsRoot(), 'essence.jsonl')
}

/** 最近几条"梦的余味"，注入用。 */
function readEssence(limit) {
  try {
    const rows = readFileSync(essenceFile(), 'utf8').split('\n')
      .filter(function (line) { return line.trim().length > 0 })
      .map(function (line) { try { return JSON.parse(line) } catch { return null } })
      .filter(function (row) { return row !== null && typeof row === 'object' && typeof row.essence === 'string' })
    return rows.slice(-(limit === undefined ? 3 : limit))
  } catch { return [] }
}

function appendEssence(row) {
  ensureDir(dreamsRoot())
  const rows = readEssence(DREAM_ESSENCE_KEEP - 1).concat([row])
  writeFileSync(essenceFile(), rows.map(function (r) { return JSON.stringify(r) }).join('\n') + '\n', { mode: 0o600 })
}

function appendHistory(name, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return
  ensureDir(accHome())
  appendFileSync(join(accHome(), name), rows.map(function (row) { return JSON.stringify(row) }).join('\n') + '\n', { mode: 0o600 })
}

function parseJsonReply(raw) {
  const text = String(raw ?? '')
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  try {
    const parsed = JSON.parse(text.slice(first, last + 1))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

/** 中文没有空格，词法靠不住；用字符二元组算"这行有没有根"。 */
function charGrams(text) {
  const clean = String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '')
  const out = new Set()
  for (let i = 0; i + 1 < clean.length; i++) out.add(clean.slice(i, i + 2))
  return out
}

/** 一行是不是从原有材料里长出来的。防模型在整理时凭空发明一个人。 */
function groundedLine(line, pool) {
  const grams = charGrams(line)
  if (grams.size === 0) return false
  let hit = 0
  for (const gram of grams) if (pool.has(gram)) hit += 1
  return hit >= Math.max(2, Math.ceil(grams.size * 0.34))
}

/**
 * 借 harness 自己的模型。优先 config 里指定的 provider/model，其次登记在前面的
 * provider；全都叫不动时，再问一次该 provider 的模型目录，拿第一个再试。
 * 别的机器上 provider 未必叫 deepseek-official，所以不能写死。
 */
async function askModel(ctx, system, user, maxTokens) {
  const llm = ctx === undefined || ctx === null ? undefined : ctx.llm
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') throw new Error('harness 没有提供 llm 服务')
  const config = readAccConfig()
  const wantedModel = typeof config.model === 'string' && config.model.length > 0 ? config.model : 'deepseek-flash'
  let providers = []
  try {
    providers = (typeof llm.listProviders === 'function' ? llm.listProviders() : [])
      .map(function (one) { return one !== null && typeof one === 'object' ? one.id : undefined })
      .filter(function (id) { return typeof id === 'string' && id.length > 0 })
  } catch { providers = [] }

  const candidates = []
  function push(provider, model) {
    if (typeof provider !== 'string' || provider.length === 0) return
    const key = provider + '\u0000' + model
    if (candidates.some(function (one) { return one.key === key })) return
    candidates.push({ key, provider, model })
  }
  if (typeof config.provider === 'string' && config.provider.length > 0) push(config.provider, wantedModel)
  for (const id of providers) push(id, wantedModel)
  if (candidates.length === 0) push('deepseek-official', wantedModel)

  async function attempt(candidate) {
    const said = []
    const kinds = {}
    let finish = ''
    for await (const chunk of llm.stream({
      provider: candidate.provider,
      model: candidate.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: system + '\n\n' + user }] }],
      maxTokens
    })) {
      if (chunk === null || typeof chunk !== 'object') continue
      kinds[String(chunk.type)] = (kinds[String(chunk.type)] ?? 0) + 1
      if (chunk.type === 'text-delta') said.push(String(chunk.text ?? ''))
      if (chunk.type === 'finish') {
        finish = typeof chunk.reason === 'string' ? chunk.reason : JSON.stringify(chunk.reason ?? '')
      }
    }
    const text = said.join('').trim()
    if (text.length === 0) {
      // 空手而归时把收到的块类型和收尾原因留下：只出推理不出正文、被截断、
      // 和根本没开始，是三种不同的毛病，报错要能分开。
      const seen = Object.keys(kinds).map(function (kind) { return kind + '×' + kinds[kind] }).join(',')
      throw new Error('模型没有返回正文（收到：' + (seen.length > 0 ? seen : '什么也没有')
        + (finish.length > 0 ? '，结束原因 ' + finish : '') + '）')
    }
    return { text, provider: candidate.provider, model: candidate.model }
  }

  let lastError = null
  // 两圈：第一圈按配置和登记顺序试；全空手再补一次——空回复有一半是偶发的，
  // 隔一秒重来就好，没必要让这周的梦就这么没了。
  for (let round = 0; round < 2; round += 1) {
    for (const candidate of candidates) {
      try { return await attempt(candidate) } catch (error) { lastError = error }
    }
    if (round > 0) break
    // 顺便补上「模型名不对」这条路：拿目录里第一个名字再试一次
    for (const id of providers) {
      let first = undefined
      try {
        const models = await llm.listModels(id)
        first = (Array.isArray(models) ? models : [])
          .map(function (one) { return one !== null && typeof one === 'object' ? one.id : undefined })
          .filter(function (model) { return typeof model === 'string' && model.length > 0 })[0]
      } catch { first = undefined }
      if (first !== undefined && first !== wantedModel) push(id, first)
    }
    await new Promise(function (resolve) { setTimeout(resolve, 1200) })
  }
  throw new Error('做梦时叫不动模型：' + String(lastError === null ? '没有可用的 provider' : lastError.message))
}

/**
 * 整理性格档。只能合并，不许新增——输出的每一行都要在原材料里有根，否则丢掉。
 * 某一面被模型清空或全是没根的，就原样保住：宁可留着，不能因为一次整理把人弄丢。
 */
async function tidyPersona(ctx) {
  const before = readPersona()
  let total = 0
  const table = {}
  for (const subject of SUBJECTS) {
    table[subject] = {}
    for (const facet of FACETS) {
      table[subject][facet] = before[subject][facet].slice()
      total += table[subject][facet].length
    }
  }
  if (total < 8) return { before: total, after: total, skipped: '材料太少，不值得整理' }
  const system = [
    '你在整理自己的性格档案。',
    '档案有两栏：you 是「和你说话的人」，me 是「你自己」（模型这一侧）。',
    '每一栏有八面：' + JSON.stringify(FACET_LABEL) + '。',
    '整理规则：',
    '1. 只能合并、压缩、去重已有条目；不许新增原文里没有的观察，也不许改口吻。',
    '2. 同一面里重复的、近义的、说的是同一件事的，合成一条更准的。',
    '3. 合并的意思是「用一条更准的话代替原来那几条」，不是把原句用分号或逗号接起来；输出里不要出现「；」，也不要一条里说两遍同一个意思。',
    '4. 每条不超过 26 字，越短越准越好；每一面最多留 ' + DREAM_KEEP_PER_FACET + ' 条，留最能刻画人的，删掉凑数的。',
    '5. 拿不准的原样保留，宁可留着也别删。',
    '输出 JSON：{"you":{"temper":[...],"mouth":[...],"affinity":[...],"habits":[...],"likes":[...],"manner":[...],"style":[...],"ability":[...]},"me":{同上}}',
    '只有 JSON，不要解释。'
  ].join('\n')
  const reply = await askModel(ctx, system, JSON.stringify({ you: table.you, me: table.me }, null, 2), 4000)
  const parsed = parseJsonReply(reply.text)
  if (parsed === null) return { before: total, after: total, skipped: '模型没给出可用的 JSON', model: reply.model }
  const next = { updatedAt: new Date().toISOString(), you: {}, me: {} }
  const retired = []
  let after = 0
  for (const subject of SUBJECTS) {
    for (const facet of FACETS) {
      const input = table[subject][facet]
      if (input.length === 0) { next[subject][facet] = []; continue }
      const pool = new Set()
      for (const line of input) for (const gram of charGrams(line)) pool.add(gram)
      const raw = parsed[subject] !== null && typeof parsed[subject] === 'object' ? parsed[subject][facet] : undefined
      const kept = []
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (typeof item !== 'string') continue
          const line = item.replace(/\s+/g, ' ').trim().slice(0, 40)
          if (line.length < 2 || kept.indexOf(line) >= 0) continue
          if (!groundedLine(line, pool)) continue
          kept.push(line)
          if (kept.length >= DREAM_KEEP_PER_FACET) break
        }
      }
      next[subject][facet] = kept.length > 0 ? kept : input.slice(-12)
      after += next[subject][facet].length
      for (const line of input) {
        if (next[subject][facet].indexOf(line) < 0) retired.push({ subject, facet, text: line, at: new Date().toISOString(), why: 'dream-tidy' })
      }
    }
  }
  // 整理期间可能又有新的观察写进来：补回去，别被这一次覆盖掉
  const latest = readPersona()
  for (const subject of SUBJECTS) {
    for (const facet of FACETS) {
      for (const line of latest[subject][facet]) {
        if (before[subject][facet].indexOf(line) >= 0) continue
        if (next[subject][facet].indexOf(line) >= 0) continue
        next[subject][facet].push(line)
        after += 1
      }
      next[subject][facet] = next[subject][facet].slice(-12)
    }
  }
  writePersona(next)
  appendHistory('persona-history.jsonl', retired)
  return { before: total, after, retired: retired.length, model: reply.model, provider: reply.provider }
}

/** 二级记忆是结论，只合并不改写；超过上限才动，动过的进 history。 */
async function tidyDeep(ctx) {
  const current = readDeep()
  const facts = current.facts.map(function (one) { return one.text })
  if (facts.length <= DREAM_DEEP_KEEP) return { before: facts.length, after: facts.length, skipped: '还没到要整理的量' }
  const system = [
    '你在整理自己记下的结论。',
    '规则：',
    '1. 只能合并、去重、压缩已有结论；不许新增结论。',
    '2. 相互矛盾的，留最新的那条，另一条并进它的措辞里。',
    '3. 最多保留 ' + DREAM_DEEP_KEEP + ' 条，每条不超过 60 字。',
    '输出 JSON：{"keep":["...","..."]}，只有 JSON。'
  ].join('\n')
  const reply = await askModel(ctx, system, JSON.stringify(facts.slice(-40), null, 2), 2500)
  const parsed = parseJsonReply(reply.text)
  const raw = parsed !== null && Array.isArray(parsed.keep) ? parsed.keep : null
  if (raw === null) return { before: facts.length, after: facts.length, skipped: '模型没给出可用的 JSON', model: reply.model }
  const pool = new Set()
  for (const fact of facts) for (const gram of charGrams(fact)) pool.add(gram)
  const kept = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const line = item.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (line.length < 2 || kept.indexOf(line) >= 0) continue
    if (!groundedLine(line, pool)) continue
    kept.push(line)
    if (kept.length >= DREAM_DEEP_KEEP) break
  }
  if (kept.length === 0) return { before: facts.length, after: facts.length, skipped: '整理结果没有一条有根，原样保留', model: reply.model }
  const now = new Date().toISOString()
  const retired = facts.filter(function (fact) { return kept.indexOf(fact) < 0 }).map(function (fact) { return { text: fact, at: now, why: 'dream-merge' } })
  writeDeep({ updatedAt: now, facts: kept.map(function (text, index) { return { id: index + 1, text, at: now } }) })
  appendHistory('deep-history.jsonl', retired)
  return { before: facts.length, after: kept.length, retired: retired.length, model: reply.model, provider: reply.provider }
}

/** 恍惚里从没被想起过的旧事，退到 history——不是删，只是不再冒出来。 */
function pruneVivid(now) {
  const state = readVivid()
  const cutoff = now.getTime() - VIVID_RETIRE_DAYS * DAY_MS
  const kept = []
  const retired = []
  for (const entry of state.entries) {
    const at = Date.parse(String(entry.at ?? ''))
    const calls = typeof entry.calls === 'number' ? entry.calls : 0
    if (calls > 0 || Number.isNaN(at) || at >= cutoff) kept.push(entry)
    else retired.push({ ...entry, why: 'dream-vivid-retire', at: now.toISOString() })
  }
  if (retired.length > 0) {
    writeVivid({ surfacedAt: state.surfacedAt, entries: kept.slice(0, VIVID_CAP) })
    appendHistory('vivid-history.jsonl', retired)
  }
  // 报的是真正落盘后的条数：kept 可能还超过 VIVID_CAP，报 kept.length 会
  // 让"200 → 106"和文件里的 60 对不上。
  return { before: state.entries.length, after: Math.min(kept.length, VIVID_CAP) }
}

/** 从真实对话里抓几段，别让梦只有性格条目那么干。 */
function sampleArchiveText(sessions, budgetChars) {
  const pool = archivedSessions(40).filter(function (entry) { return entry.plain || entry.sealed })
  const chunks = []
  let used = 0
  for (let round = 0; round < sessions && pool.length > 0; round++) {
    const entry = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]
    const text = readArchive(entry)
    if (text.length === 0) continue
    const records = []
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const record = JSON.parse(line)
        if (record !== null && typeof record === 'object' && typeof record.text === 'string' && record.text.trim().length > 0 && (record.role === 'user' || record.role === 'assistant')) records.push(record)
      } catch { /* 断尾 */ }
    }
    if (records.length === 0) continue
    const taken = []
    for (let pick = 0; pick < 4 && records.length > 0; pick++) {
      taken.push(records.splice(Math.floor(Math.random() * records.length), 1)[0])
    }
    for (const record of taken) {
      const body = String(record.text).replace(/\s+/g, ' ').trim().slice(0, 240)
      if (body.length === 0 || used + body.length > budgetChars) break
      chunks.push('（' + (record.role === 'user' ? '他说' : '我说') + '）' + body)
      used += body.length
    }
  }
  return chunks.join('\n')
}

function storyMaterial() {
  const persona = readPersona()
  const lines = []
  for (const subject of SUBJECTS) {
    for (const facet of FACETS) {
      for (const item of persona[subject][facet]) {
        lines.push((subject === 'you' ? '你' : '我') + '·' + FACET_LABEL[facet] + '：' + item)
      }
    }
  }
  const deep = readDeep().facts.slice(-DREAM_DEEP_KEEP).map(function (one) { return '结论：' + one.text })
  const vivid = readVivid().entries.slice(-6).map(function (one) { return '瞬间：' + clipText(one.text, 90) })
  const archive = sampleArchiveText(3, 900)
  return { persona: lines, deep, vivid, archive }
}

/**
 * 人设梦：用记忆编一个 600 字左右的短故事，再压成一句话。
 * 故事不进上下文（那才是真的超长）；进去的只有那一句，用来提醒"我是谁"。
 */
async function dreamStory(ctx, material) {
  const system = [
    '你在做梦。梦不是凭空想象，是记忆自己重新拼了一遍。',
    '下面是你记得的东西：性格档案、已经定下的结论、几个零碎的瞬间，还有几段真实的对话。',
    '写一个 600 字左右的小故事（550 到 700 字之间，写不短就删细节，不要超过 700 字）。规则：',
    '1. 故事里的人、习惯、结论、场景，都必须来自上面的记忆；不许发明新的关系、身份或经历。',
    '2. 可以拼接、可以颠倒时间、可以把两件事压成一件——梦本来就是这么干的。',
    '3. 用你自己的口吻写，写具体的东西，不要总结，不要解释，也不要写「这说明……」。',
    '4. 结尾不要点题。',
    '然后按这个格式输出，四行开头一个都不能少，不要用 JSON，不要解释：',
    '标题：（一行，不超过 12 字）',
    '故事：',
    '（正文写在这里，600 字左右）',
    '余味：（一句话，不超过 20 字，说这个故事讲了什么；这句会留在你的性格档案里）'
  ].join('\n')
  const body = [
    '【性格档案】', material.persona.join('\n') || '（空）',
    '', '【结论】', material.deep.join('\n') || '（空）',
    '', '【瞬间】', material.vivid.join('\n') || '（空）',
    '', '【对话碎片】', material.archive || '（空）'
  ].join('\n')
  // 600 字的故事加上模型自己的推理，2600 会被截断；给够，不然只出推理没有正文。
  const reply = await askModel(ctx, system, body, 6000)
  const read = parseStoryReply(reply.text)
  if (read === null) return null
  return { title: read.title, story: read.story, essence: read.essence, model: reply.model, provider: reply.provider }
}

/**
 * 故事是长散文，硬要它包在 JSON 里，引号和换行很容易把 JSON 弄坏——所以主格式是
 * 带标签的纯文本，JSON 只当兼容路径。两种都认，认不出来才认失败。
 */
function parseStoryReply(raw) {
  const text = String(raw ?? '').replace(/\r/g, '').replace(/^```[a-z]*\s*$/gm, '').trim()
  if (text.length === 0) return null
  const json = parseJsonReply(text)
  if (json !== null && typeof json.story === 'string' && json.story.trim().length >= 240) {
    const story = json.story.trim()
    const title = oneLine(json.title ?? '').slice(0, 20) || '没有标题的梦'
    const essence = oneLine(json.essence ?? '').slice(0, DREAM_ESSENCE_MAX) || title
    return { title, story, essence }
  }
  const titleMatch = /^\s*[#*]*\s*标题[:：]\s*(.+)$/m.exec(text)
  const essenceMatch = /^\s*[#*]*\s*余味[:：]\s*(.+)$/m.exec(text)
  const body = text.split('\n')
    .filter(function (line) { return !/^\s*[#*]*\s*标题[:：]/.test(line) && !/^\s*[#*]*\s*余味[:：]/.test(line) && !/^\s*[#*]*\s*故事[:：]\s*$/.test(line) })
    .join('\n')
    .trim()
  if (body.length < 240) return null
  const title = oneLine(titleMatch === null ? '' : titleMatch[1]).slice(0, 20) || '没有标题的梦'
  const essence = oneLine(essenceMatch === null ? '' : essenceMatch[1]).slice(0, DREAM_ESSENCE_MAX) || title
  return { title, story: body, essence }
}

/**
 * 做一次梦：先整理（性格 / 结论 / 恍惚），人设够料时再编一个故事。
 * 每一步单独兜底：整理失败不该让故事也做不成，反过来也一样。
 */
async function runDream(ctx, options) {
  const manual = options !== undefined && options !== null && options.manual === true
  if (DREAM_RUNNING) return { ok: false, error: '已经有一个梦在做了，等它做完' }
  if (engineList().length > 1) return { ok: false, error: '两个记忆引擎都装着：先二选一，做梦会写坏档案' }
  DREAM_RUNNING = true
  const started = Date.now()
  const at = new Date()
  const record = { at: at.toISOString(), week: dreamWeek(at).label, ok: true, kind: 'tidy', manual, useful: false, steps: [], errors: [] }
  try {
    try {
      const persona = await tidyPersona(ctx)
      record.persona = persona
      if ((persona.retired ?? 0) > 0 || persona.after < persona.before) record.useful = true
      record.steps.push('性格 ' + persona.before + ' → ' + persona.after + (persona.skipped ? '（' + persona.skipped + '）' : ''))
    } catch (error) { record.errors.push('性格：' + String(error?.message ?? error)) }

    try {
      const deep = await tidyDeep(ctx)
      record.deep = deep
      if ((deep.retired ?? 0) > 0) record.useful = true
      record.steps.push('结论 ' + deep.before + ' → ' + deep.after + (deep.skipped ? '（' + deep.skipped + '）' : ''))
    } catch (error) { record.errors.push('结论：' + String(error?.message ?? error)) }

    try {
      const vivid = pruneVivid(at)
      record.vivid = vivid
      if (vivid.before !== vivid.after) { record.useful = true; record.steps.push('恍惚 ' + vivid.before + ' → ' + vivid.after) }
    } catch (error) { record.errors.push('恍惚：' + String(error?.message ?? error)) }

    const material = storyMaterial()
    if (material.persona.length >= 6) {
      try {
        const story = await dreamStory(ctx, material)
        if (story === null) {
          record.errors.push('故事没编成：模型输出不够用')
        } else {
          record.kind = 'persona'
          record.useful = true
          record.story = story
          record.model = story.provider + ' / ' + story.model
          record.steps.push('故事 ' + story.story.length + ' 字')
          ensureDir(dreamsRoot())
          const stem = dreamStamp(record.at)
          writeFileSync(join(dreamsRoot(), stem + '-story.md'), [
            '# ' + story.title, '', story.story, '', '— ' + story.essence, '',
            '（' + record.at + ' 做的一场梦 · ' + record.model + '）'
          ].join('\n') + '\n', { mode: 0o600 })
          appendEssence({ at: record.at, week: record.week, title: story.title, essence: story.essence, story: stem + '-story.md' })
        }
      } catch (error) { record.errors.push('故事：' + String(error?.message ?? error)) }
    } else {
      record.steps.push('人设材料不够，这次只整理')
    }

    // 一次梦必须真的做了点什么，或者确实没有可做的事。全都失败不算做过——
    // 算了的话，下次就以为这周已经做过一次了。
    if (!record.useful && record.errors.length > 0) record.ok = false
  } finally {
    DREAM_RUNNING = false
  }
  record.ms = Date.now() - started
  try {
    ensureDir(dreamsRoot())
    writeFileSync(join(dreamsRoot(), dreamStamp(record.at) + '.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
  } catch { /* 记录写不进去不影响做梦本身 */ }
  if (record.ok) {
    const state = readDreamState()
    const week = dreamWeek(at).label
    const sameWeek = state.week === week
    writeDreamState({
      ...state,
      week,
      count: (sameWeek ? state.count : 0) + 1,
      lastAt: record.at,
      fireAt: 0,
      rolledDay: state.rolledDay,
      failures: 0,
      lastError: ''
    })
  } else {
    // 连着失败就退避：2h → 4h → 8h → 16h → 48h。别让一个坏掉的 key
    // 每两小时烧一次请求，也别一次失败就永久放弃。
    const state = readDreamState()
    const failures = state.failures + 1
    const hours = Math.min(48, 2 * Math.pow(2, Math.min(4, failures - 1)))
    writeDreamState({
      ...state,
      fireAt: Date.now() + hours * 3600 * 1000,
      failures,
      lastError: record.errors.join('；').slice(0, 300)
    })
  }
  return record
}

function dreamStatus() {
  const config = readAccConfig()
  const state = readDreamState()
  const now = new Date()
  const week = dreamWeek(now)
  const sameWeek = state.week === week.label
  const perWeek = Number.isFinite(Number(config.dreamPerWeek)) ? Math.max(1, Math.min(7, Math.floor(Number(config.dreamPerWeek)))) : DREAM_TARGET
  let files = []
  try {
    files = readdirSync(dreamsRoot())
      .filter(function (name) { return name.endsWith('.json') && name !== 'state.json' })
      .sort()
      .slice(-6)
      .reverse()
  } catch { files = [] }
  const count = sameWeek ? state.count : 0
  const carry = sameWeek ? state.carry : 0
  const need = Math.max(0, perWeek + carry - count)
  const daysLeft = Math.max(1, Math.ceil((week.end - now.getTime()) / DAY_MS))
  return {
    enabled: config.dreamEnabled !== false,
    perWeek,
    week: week.label,
    count,
    carry,
    lastAt: state.lastAt,
    fireAt: sameWeek ? state.fireAt : 0,
    running: DREAM_RUNNING,
    failures: state.failures,
    lastError: state.lastError,
    // 只报账，不掷色子：掷色子只在 maybeDream 里发生，看状态不该改变状态。
    plan: {
      need,
      daysLeft,
      chance: need === 0 ? 0 : Math.min(1, need / daysLeft),
      rolledToday: sameWeek && state.rolledDay === dayKey(now),
      due: need > 0 && sameWeek && state.fireAt > 0 && Date.now() >= state.fireAt
    },
    essence: readEssence(3),
    files
  }
}

/**
 * 掷色子。每 tick 叫一次都便宜（只读一个小文件），所以可以放心每 5 分钟问。
 * 规则：本周还欠几次 / 还剩几天 = 今天中的概率；剩下的日子不够还债了，就直接做实。
 */
async function maybeDream(ctx, reason) {
  if (DREAM_RUNNING) return
  if (engineList().length > 1) return
  const config = readAccConfig()
  if (config.dreamEnabled === false) return
  // 关掉的引擎不配做梦：它连上下文都不注入，后台还调模型就是偷算力
  if (readMode() === 'off') return
  const perWeek = Number.isFinite(Number(config.dreamPerWeek)) ? Math.max(1, Math.min(7, Math.floor(Number(config.dreamPerWeek)))) : DREAM_TARGET
  const now = new Date()
  const week = dreamWeek(now)
  let state = readDreamState()
  if (state.week !== week.label) {
    // 跨周了。上周一次都没做，就欠一次——但只欠一次，不滚雪球。
    const missed = state.week !== '' && state.count === 0
    state = { week: week.label, count: 0, carry: missed ? 1 : 0, lastAt: state.lastAt, rolledDay: '', fireAt: 0, failures: 0, lastError: state.lastError }
    writeDreamState(state)
  }
  const need = perWeek + (state.carry > 0 ? 1 : 0) - state.count
  if (need <= 0) return
  const lastAt = state.lastAt.length > 0 ? Date.parse(state.lastAt) : Number.NaN
  const gap = Number.isNaN(lastAt) ? Infinity : Date.now() - lastAt
  if (gap < DREAM_MIN_GAP_MS) return

  if (state.rolledDay !== dayKey(now)) {
    const daysLeft = Math.max(1, Math.ceil((week.end - now.getTime()) / DAY_MS))
    const chance = Math.min(1, need / daysLeft)
    const hit = Math.random() < chance
    state.rolledDay = dayKey(now)
    state.fireAt = hit ? Date.now() + 20000 + Math.floor(Math.random() * 3 * 3600 * 1000) : 0
    writeDreamState(state)
  }
  // 别把债拖到周末：过了周中一次都没做，或者剩下的日子不够还，就直接做实。
  // 机器不是天天开着，等色子等到最后一天，往往就等没了。
  const msLeft = week.end - Date.now()
  const daysLeft = Math.ceil(msLeft / DAY_MS)
  const force = msLeft < need * DAY_MS * 0.75 || (state.count === 0 && daysLeft <= Math.ceil(perWeek * 2))
  if (state.fireAt === 0 && force) {
    state.fireAt = Date.now() + 15000
    writeDreamState(state)
  }
  if (state.fireAt > 0 && Date.now() >= state.fireAt) {
    await runDream(ctx, { manual: false, reason: reason ?? 'tick' })
  }
}

function dreamFileNameSafe(name) {
  return typeof name === 'string' && /^[0-9A-Za-z_-]+\.json$/.test(name) ? name : ''
}

function readDreamFile(name) {
  const safe = dreamFileNameSafe(name)
  if (safe.length === 0) return null
  try { return JSON.parse(readFileSync(join(dreamsRoot(), safe), 'utf8')) } catch { return null }
}

// --- S4: the backup pyramid ---------------------------------------------------
// daily -> weekly -> monthly -> yearly, each level keeping one representative and
// the level below losing its redundant copies. Deletion is a MOVE into trash/,
// never unlink: rotation is the one place ACC destroys something, so it destroys
// nothing irreversibly. Backups stay plaintext and read-only (0444) on purpose:
// a backup you cannot open without a key is not a backup.
function backupRoot() {
  const config = readAccConfig()
  return config.backupRoot !== undefined && config.backupRoot.length > 0 ? config.backupRoot : join(accHome(), "backups")
}

function isoWeekStamp(date) {
  const probe = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = probe.getUTCDay() || 7
  probe.setUTCDate(probe.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(probe.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((probe - yearStart) / 86400000 + 1) / 7)
  return probe.getUTCFullYear() + "-W" + String(week).padStart(2, "0")
}

function dayKey(date) {
  return date.toISOString().slice(0, 10)
}
function monthKey(date) {
  return date.toISOString().slice(0, 7)
}
function yearKey(date) {
  return date.toISOString().slice(0, 4)
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}

/**
 * Write one plaintext, read-only snapshot. A snapshot is IMMUTABLE: it is written
 * once, sealed 0444, and never rewritten — a backup you can edit is not evidence.
 * That is also why a day's first write wins: later changes belong to tomorrow's
 * snapshot, not to an overwrite of today's.
 */
function writeBackup(tier, key, date, range, why) {
  const dir = join(backupRoot(), tier, key)
  if (existsSync(join(dir, 'persona.json'))) return dir
  ensureDir(dir)
  const persona = readPersona()
  const file = join(dir, 'persona.json')
  const body = JSON.stringify(persona, null, 2) + '\n'
  writeFileSync(file, body)
  safeChmod(file, 0o444)
  const counts = { you: {}, me: {} }
  for (const subject of SUBJECTS) for (const facet of FACETS) counts[subject][facet] = persona[subject][facet].length
  const manifest = join(dir, 'manifest.json')
  writeFileSync(manifest, JSON.stringify({
    tier,
    key,
    takenAt: date.toISOString(),
    range: range ?? key + ' ~ ' + key,
    why: why ?? 'scheduled snapshot',
    source: personaFile(),
    restoreTo: personaFile(),
    files: ['persona.json'],
    sha256: createHash('sha256').update(body).digest('hex'),
    facetCounts: counts,
    immutable: true,
    note: 'plaintext and read-only on purpose: a backup you cannot open without a key is not a backup'
  }, null, 2) + '\n')
  safeChmod(manifest, 0o444)
  return dir
}

function tierKeys(tier) {
  const dir = join(backupRoot(), tier)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(function (name) {
    try { return statSync(join(dir, name)).isDirectory() } catch { return false }
  }).sort()
}

function rootReadme() {
  return [
    'ACC 记忆备份',
    '',
    '规则只有两条：写完之后要么被删除，要么永久只读保存。备份文件是 444 只读，',
    '程序不会改写它——一个能被改写的备份不能算证据。',
    '',
    '四层金字塔，每层只留一份代表，归并后下级冗余副本移进 trash：',
    '  daily/    最近 7 天          目录名 = YYYY-MM-DD',
    '  weekly/   每月约 4~5 份      目录名 = ISO 周（manifest 的 range 写明起止）',
    '  monthly/  每年 12 份         目录名 = YYYY-MM',
    '  yearly/   永久保存           目录名 = YYYY',
    '  trash/    被归并掉的旧副本，暂存 7 天后真正删除',
    '',
    '每个快照目录里固定两个文件：',
    '  persona.json   性格八面，结构 { updatedAt, you:{…}, me:{…} }',
    '  manifest.json  来源、恢复目标、sha256、八面计数',
    '',
    '人工恢复步骤：',
    '  1. 从最上面一层有内容的目录开始，取日期最新的 key',
    '  2. 把该目录的 persona.json 复制到 manifest.restoreTo 指向的路径',
    '  3. 重启 harness（或等下一次会话自动读入）',
    '',
    '注意：备份只含性格八面，不含对话归档。',
    ''
  ].join('\n')
}

/** Drop the root README if it is missing. Read-only, like everything here. */
function ensureReadme() {
  const root = backupRoot()
  ensureDir(root)
  const file = join(root, 'README.txt')
  if (existsSync(file)) return file
  writeFileSync(file, rootReadme())
  safeChmod(file, 0o444)
  return file
}

/** Move a tier directory into trash instead of deleting it, with a written reason. */
function toTrash(tier, key, why) {
  const from = join(backupRoot(), tier, key)
  if (!existsSync(from)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = ensureDir(join(backupRoot(), 'trash', stamp))
  const reason = join(dest, 'reason.json')
  if (!existsSync(reason)) {
    writeFileSync(reason, JSON.stringify({
      at: new Date().toISOString(),
      why: why ?? 'merged into the level above',
      from: tier + '/' + key,
      immutable: true
    }, null, 2) + '\n')
    safeChmod(reason, 0o444)
  }
  renameSync(from, join(dest, tier + '-' + key))
  return join(dest, tier + '-' + key)
}

/**
 * Roll every level up one step where it is due, then drop the redundant copy.
 * Idempotent. Nothing here edits an existing snapshot: a new tier entry is a new
 * file, and the copies it replaces move to trash — the only two outcomes a backup
 * is allowed to have are "kept read-only" and "deleted".
 */
function rotateBackups(now) {
  const today = now ?? new Date()
  const report = { took: [], rolled: [], trashed: [], purged: [] }
  ensureReadme()
  report.took.push(writeBackup("daily", dayKey(today), today, dayKey(today) + " ~ " + dayKey(today)))

  const currentWeek = isoWeekStamp(today)
  const byWeek = {}
  for (const key of tierKeys("daily")) {
    const week = isoWeekStamp(new Date(key + "T00:00:00Z"))
    if (week === currentWeek) continue
    byWeek[week] = byWeek[week] ?? []
    byWeek[week].push(key)
  }
  for (const week of Object.keys(byWeek).sort()) {
    const days = byWeek[week].sort()
    const last = days[days.length - 1]
    report.rolled.push(writeBackup("weekly", week, new Date(last + "T00:00:00Z"), days[0] + " ~ " + last, "merged from " + days.length + " daily snapshot(s)"))
    for (const day of days) { const moved = toTrash("daily", day, "merged into " + week); if (moved !== null) report.trashed.push(moved) }
  }

  const currentMonth = monthKey(today)
  const byMonth = {}
  for (const key of tierKeys("weekly")) {
    const weekStart = weekStartDate(key)
    const monthOfWeek = weekStart === null ? currentMonth : monthKey(new Date(weekStart.getTime() + 6 * 86400000))
    if (monthOfWeek === currentMonth) continue
    byMonth[monthOfWeek] = byMonth[monthOfWeek] ?? []
    byMonth[monthOfWeek].push(key)
  }
  for (const month of Object.keys(byMonth).sort()) {
    const weeks = byMonth[month].sort()
    const last = weeks[weeks.length - 1]
    report.rolled.push(writeBackup("monthly", month, weekStartDate(last) ?? today, weeks[0] + " ~ " + last, "merged from " + weeks.length + " weekly snapshot(s)"))
    for (const week of weeks) { const moved = toTrash("weekly", week, "merged into " + month); if (moved !== null) report.trashed.push(moved) }
  }

  const currentYear = yearKey(today)
  const byYear = {}
  for (const key of tierKeys("monthly")) {
    const year = key.slice(0, 4)
    if (year === currentYear) continue
    byYear[year] = byYear[year] ?? []
    byYear[year].push(key)
  }
  for (const year of Object.keys(byYear).sort()) {
    const months = byYear[year].sort()
    const last = months[months.length - 1]
    report.rolled.push(writeBackup("yearly", year, new Date(last + "-01T00:00:00Z"), months[0] + " ~ " + last, "merged from " + months.length + " monthly snapshot(s)"))
    for (const month of months) { const moved = toTrash("monthly", month, "merged into " + year); if (moved !== null) report.trashed.push(moved) }
  }

  report.purged = purgeTrash(today, 7)
  return report
}

/** The deletion branch: trash older than the grace period is removed for good. */
function purgeTrash(now, days) {
  const root = join(backupRoot(), 'trash')
  if (!existsSync(root)) return []
  const cutoff = (now ?? new Date()).getTime() - (days === undefined ? 7 : days) * 86400000
  const removed = []
  for (const name of tierKeys('trash')) {
    const dir = join(root, name)
    let info = null
    try { info = statSync(dir) } catch { continue }
    if (info.mtimeMs > cutoff) continue
    rmSync(dir, { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

/** First day of an ISO week label like 2026-W44. */
function weekStartDate(label) {
  const match = /^(\d{4})-W(\d{2})$/.exec(label)
  if (match === null) return null
  const year = Number(match[1])
  const week = Number(match[2])
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const day = jan4.getUTCDay() || 7
  const monday = new Date(jan4.getTime() - (day - 1) * 86400000 + (week - 1) * 7 * 86400000)
  return monday
}

function backupTree() {
  const root = backupRoot()
  const out = { root, tiers: {} }
  for (const tier of ["daily", "weekly", "monthly", "yearly", "trash"]) {
    out.tiers[tier] = tierKeys(tier)
  }
  return out
}

// --- images: keep what the picture meant, not the picture ---------------------
// Bytes are not copied and not rotated: the model reads the image once, the text
// description is what survives. Same picture twice is described once.
function attachmentPath(id) {
  return join(home(), "attachments", "v1", "objects", id.slice(0, 2), id)
}

function descriptionCache() {
  const file = join(accHome(), "attachments.json")
  try { const parsed = JSON.parse(readFileSync(file, "utf8")); return parsed !== null && typeof parsed === "object" ? parsed : {} } catch { return {} }
}

function saveDescription(id, text) {
  const cache = descriptionCache()
  cache[id] = { text, at: new Date().toISOString() }
  mkdirSync(accHome(), { recursive: true })
  writeFileSync(join(accHome(), "attachments.json"), JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 })
}

/**
 * Ask the model what the image is, in at most 400 characters and without repeating
 * the words printed inside it. Failure is recorded, never fatal: losing one
 * description must not lose the conversation it belonged to.
 */
async function describeImage(llm, id) {
  const cached = descriptionCache()[id]
  if (cached !== undefined && typeof cached.text === "string") return cached.text
  const path = attachmentPath(id)
  if (!existsSync(path)) return ""
  const messages = [{
    role: "user",
    content: [
      { type: "text", text: "用不超过 400 字说明这张图里是什么、有什么、什么场景。不要复述图片中的文字：界面、比分、聊天、按钮上的字都不算。" },
      { type: "image", attachment: { attachmentId: id, readonlyPath: path } }
    ]
  }]
  const said = []
  for await (const chunk of llm.stream({ provider: "deepseek-official", model: "deepseek-flash", messages, maxTokens: 4000 })) {
    if (chunk !== null && typeof chunk === "object" && chunk.type === "text-delta") said.push(String(chunk.text ?? ""))
  }
  const text = said.join("").trim().slice(0, 400)
  if (text.length > 0) saveDescription(id, text)
  return text
}

/**
 * Fill image placeholders from descriptions the MAIN model supplied.
 *
 * The main model is already looking at the image, so describing it costs nothing
 * extra; asking the memory model to look again means shipping bytes through a
 * second path that is easy to get wrong. Caller-supplied text wins, the cache is
 * the fallback, and an unknown image degrades to a marker rather than failing.
 */
function applyImageTexts(records, provided) {
  if (Array.isArray(provided)) {
    for (const entry of provided) {
      if (entry === null || typeof entry !== "object") continue
      const id = String(entry.id ?? "").trim()
      const text = String(entry.text ?? "").trim().slice(0, 400)
      if (id.length > 0 && text.length > 0) saveDescription(id, text)
    }
  }
  const cache = descriptionCache()
  for (const record of records) {
    if (!Array.isArray(record.images) || record.images.length === 0) continue
    let text = String(record.text ?? "")
    for (const id of record.images) {
      const known = cache[id]
      const described = known !== undefined && typeof known.text === "string" ? known.text : ""
      text = text.split("[图片 " + id + "]").join(described.length > 0 ? "[图片：" + described + "]" : "[图片 未识别 " + id.slice(0, 8) + "…]")
    }
    record.text = text
  }
  return records
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/**
 * Prove the point of this fork: a plugin can use the harness's OWN model, with the
 * harness's own credentials. No key file, no DSH_MEMORY_API_KEY, nothing to paste.
 * GET /dsh-acc/probe?provider=&model=
 */
async function probe(ctx, req, res) {
  const url = new URL(req.url, 'http://local')
  const wanted = url.searchParams.get('provider') ?? ''
  const model = url.searchParams.get('model') ?? 'deepseek-flash'
  const out = { hash: 'probe-1' }
  try {
    const llm = ctx.llm
    const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    out.providers = providers.map((one) => one.id)
    const provider = wanted.length > 0 ? wanted : (providers[0]?.id ?? '')
    if (provider.length === 0) { out.ok = false; out.error = 'no registered provider'; return sendJson(res, 200, out) }
    const started = Date.now()
    const said = []
    const thought = []
    for await (const chunk of llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: '回复两个字：收到' }] }],
      maxTokens: 128
    })) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') said.push(String(chunk.text ?? ''))
      if (chunk.type === 'reasoning-delta') thought.push(String(chunk.text ?? ''))
    }
    out.ok = true
    out.provider = provider
    out.model = model
    out.text = said.join('')
    out.reasoningChars = thought.join('').length
    out.ms = Date.now() - started
    out.env = Object.keys(process.env).filter((k) => k.includes('MEMORY')).join(',') || '（无任何 MEMORY 环境变量）'
  } catch (error) {
    out.ok = false
    out.error = String((error && error.message) || error)
  }
  return sendJson(res, 200, out)
}

function applyInner(ctx) {
  // Mutual exclusion, enforced where it can actually be observed: when another
  // memory engine signed in first, ACC keeps its reporting route and drops its
  // tools, so two memory chains never run in one turn.
  // 「装了没装」看 patch，「跑没跑」看表。两个都装就必然冲突，不取决于谁先 apply。
  const installed = readProfileEngines()
  const bothInstalled = installed !== null && installed.memory === true && installed.acc === true
  const engineConflict = bothInstalled || engineList().length > 1
  ACC_TOOLS_REGISTERED = !engineConflict
  if (engineConflict) {
    ctx.logger?.warn?.('dsh-memory-acc: another memory engine is signed in; tools disabled')
  } else {
  ctx.effect(() => ctx.tools.register({
    name: 'acc_archive',
    description: 'Archive a complete conversation from the session log into the ACC store, and say what was written. Use it to check that a conversation is preserved, or to bring an older session into the archive. It never modifies the session log.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id to archive. Omit for the newest session.' },
        list: { type: 'boolean', description: 'Only list archivable sessions, do not write anything.' },
        images: {
          type: 'array',
          description: 'Descriptions of images you can see in this conversation, so the archive keeps what they showed after the files are gone. Only the ones you actually looked at.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'The attachment id shown as [图片 <id>] in the transcript.' },
              text: { type: 'string', description: 'Up to 400 characters about what the image shows. Do not repeat words printed inside it.' }
            },
            required: ['id', 'text']
          }
        }
      }
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args) {
      const input = args ?? {}
      const all = listSessions()
      if (all.length === 0) return '没有找到任何会话日志（' + join(home(), 'sessions') + '）。'

      if (input.list === true) {
        return all.slice(0, 20).map((s) => s.session + '  ' + (s.bytes / 1024).toFixed(0) + ' KB  ' + new Date(s.mtime).toISOString().slice(0, 10)).join('\n')
      }

      const wanted = typeof input.session === 'string' && input.session.trim().length > 0 ? input.session.trim() : ''
      const target = wanted.length > 0 ? all.find((s) => s.session === wanted) : all[0]
      if (target === undefined) return '没有这个会话：' + wanted

      const decoded = decodeLog(target.log)
      const text = decoded.text
      const events = []
      for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue
        try { events.push(JSON.parse(line)) } catch { /* a torn tail line is not fatal */ }
      }

      const records = []
      for (const event of events) {
        const record = toRecord(event)
        if (record !== null) records.push(record)
      }

      const base = dataRoot()
      applyImageTexts(records, input.images)

      const outDir = join(base, target.workspace, target.session)
      mkdirSync(outDir, { recursive: true })
      const payload = Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
      const config = readAccConfig()
      const password = accKey()
      const sealed = config.encrypt && password.length > 0
      const body = sealed ? seal(payload, password) : payload
      writeFileSync(join(outDir, sealed ? 'conversation.jsonl.acc' : 'conversation.jsonl'), body, { mode: 0o600 })
      writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
        session: target.session,
        workspace: target.workspace,
        sourceLog: target.log,
        sourceBytes: target.bytes,
        events: events.length,
        decode: decoded.how,
        kept: records.length,
        archivedAt: new Date().toISOString(),
        note: 'derived from the session log; the log itself was not modified'
      }, null, 2) + '\n')

      const counts = records.reduce((acc, r) => { acc[r.role] = (acc[r.role] ?? 0) + 1; return acc }, {})
      return '已归档 ' + target.session + '\n'
        + '  事件 ' + events.length + ' → 保留 ' + records.length + ' 条（'
        + Object.entries(counts).map(([k, v]) => k + ' ' + v).join(' · ') + '）\n'
        + '  ' + outDir + '\n'
        + '  ' + (sealed ? 'conversation.jsonl.acc' : 'conversation.jsonl') + ' + manifest.json'
    }
  }), 'dsh-memory-acc.archive')
  }

  ctx.effect(() => {
    engines()[ENGINE_ID] = { kind: 'acc', version: VERSION, at: Date.now() }
    return () => { delete engines()[ENGINE_ID] }
  }, 'dsh-memory-acc.handshake')

  if (!engineConflict) ctx.effect(() => ctx.tools.register({
    name: 'acc_search',
    description: 'Search the archived conversations from a vague memory: a handful of words is enough, the exact phrase is not required. Returns the matching turns with the session they came from, newest and best first. Use acc_archive first if a session was never archived.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words you remember, space separated.' },
        limit: { type: 'integer', description: 'How many turns, 1-30. Defaults to 12.' }
      },
      required: ['query']
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args) {
      const input = args ?? {}
      const query = String(input.query ?? '')
      const limit = Math.min(30, Math.max(1, typeof input.limit === 'number' ? Math.floor(input.limit) : 12))
      const hits = searchArchives(query, limit)
      if (hits.length === 0) return '没有命中。可能这段对话还没归档，先调 acc_archive。'
      return drift + hits.map((hit) => '[' + hit.session.slice(0, 18) + '… ' + (hit.at ?? '').slice(0, 16) + ' ' + hit.role + '] 得分 ' + hit.score + '\n  ' + hit.text.slice(0, 220).replace(/\n/g, ' ')).join('\n\n')
    }
  }), 'dsh-memory-acc.search')

  if (!engineConflict) ctx.effect(() => ctx.tools.register({
    name: 'acc_persona',
    description: 'Read or add to the eight-facet profile of the person you talk with: temper, mouth, affinity, habits, likes, manner, style, ability. Reading is local and free. Adding one observation writes a single line into one facet.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'add'], description: 'read the profile, or add one observation.' },
        who: { type: 'string', enum: SUBJECTS, description: 'you = the human, me = this model. Defaults to you.' },
        facet: { type: 'string', enum: FACETS, description: 'Which facet an added observation belongs to.' },
        text: { type: 'string', description: 'The observation, up to 120 characters.' }
      }
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args) {
      const input = args ?? {}
      if (input.action === 'add') {
        if (!FACETS.includes(input.facet)) throw new Error('facet must be one of ' + FACETS.join(', '))
        const text = String(input.text ?? '').trim()
        if (text.length === 0) throw new Error('text is required')
        const subject = input.who === 'me' ? 'me' : 'you'
        const next = writePersona(addFacet(readPersona(), subject, input.facet, text.slice(0, 120)))
        return '已记入「' + (subject === 'me' ? '我' : '你') + '·' + FACET_LABEL[input.facet] + '」：' + text + '（共 ' + next[subject][input.facet].length + ' 条）'
      }
      const persona = readPersona()
      const lines = []
      for (const subject of SUBJECTS) {
        const title = subject === 'you' ? '你' : '我'
        const parts = []
        for (const facet of FACETS) {
          if (persona[subject][facet].length === 0) continue
          parts.push(FACET_LABEL[facet] + '：' + persona[subject][facet].join('；'))
        }
        if (parts.length > 0) lines.push('【' + title + '】\n' + parts.join('\n'))
      }
      return lines.length === 0 ? '性格档案还是空的。' : lines.join('\n\n')
    }
  }), 'dsh-memory-acc.persona')

  if (!engineConflict) ctx.effect(() => ctx.tools.register({
    name: 'acc_dream',
    description: '做梦：把记忆整理一遍（性格档合并去重、结论合并、恍惚退旧），人设材料够时再用记忆编一个 600 字左右的短故事，压成一句话留下。平时每周至少两次由骰子自动做；这个工具用来看状态或手动做一次。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'run', 'list', 'read'], description: 'status=这周做了几次；run=现在做一次；list=最近的梦；read=读某个梦（要 at）。' },
        at: { type: 'string', description: 'read 用：dreams 目录下的文件名，含 .json。' }
      }
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args) {
      const input = args ?? {}
      if (input.action === 'run') {
        const record = await runDream(ctx, { manual: true })
        const head = record.ok === true
          ? '做完了（' + Math.round(record.ms / 1000) + ' 秒）：' + (record.steps ?? []).join(' · ')
          : '这次梦没做成：' + (record.errors ?? []).join('；')
        return head + (record.story ? '\n\n《' + record.story.title + '》\n' + record.story.story + '\n\n— ' + record.story.essence : '')
      }
      if (input.action === 'list') {
        const status = dreamStatus()
        return status.files.length === 0 ? '还没做过梦。' : status.files.map(function (name) { return '- ' + name }).join('\n')
      }
      if (input.action === 'read') {
        const one = readDreamFile(String(input.at ?? ''))
        if (one === null) return '没有这个梦：' + String(input.at ?? '')
        return '时间：' + one.at + '（' + one.week + '）\n步骤：' + (one.steps ?? []).join(' · ')
          + (one.story ? '\n\n《' + one.story.title + '》\n' + one.story.story + '\n\n— ' + one.story.essence : '')
          + ((one.errors ?? []).length > 0 ? '\n\n问题：' + (one.errors ?? []).join('；') : '')
      }
      const status = dreamStatus()
      return '本周（' + status.week + '）：' + status.count + ' / ' + status.perWeek + (status.carry > 0 ? '（还欠上周一次）' : '')
        + '\n开关：' + (status.enabled ? '开' : '关') + '；上次：' + (status.lastAt.length > 0 ? status.lastAt : '还没做过')
        + (status.lastError.length > 0 ? '\n上次出错：' + status.lastError : '')
        + (status.essence.length > 0 ? '\n余味：' + status.essence.map(function (one) { return one.essence }).join(' / ') : '')
    }
  }), 'dsh-memory-acc.dream')

  // --- compatibility aliases ---------------------------------------------------
  // A session that ran under the standard engine carries its contract in history:
  // every turn ends with memory_report. Switching the engine must not break those
  // sessions, so the same names exist here and mean the ACC thing.
  if (!engineConflict) ctx.effect(() => ctx.systemPrompt.section({
    name: 'dsh-memory-acc:pipeline',
    order: 700,
    text: () => [
      '记忆流程（ACC）：',
      '· 归档是自动的：ACC 自己从会话日志提取，你不需要每轮汇报任何东西。',
      '· 唯一需要你补的是图片：这一轮如果看过图，把图内容写进 acc_archive 的 images 参数（≤400 字，不复述图中文字）。',
      '· 需要旧内容时用 acc_search 或 memory_read：给几个记得的词就够。',
      '· 回忆要用"印象"的口吻，不是"存储报告"：说「我对那张图的印象就这些」，不要解释"这是归档的描述""我没有原件了"这类存储细节——对方要的是你的记忆，不是你的结构。',
      '· 想留一句对人的印象，用 acc_persona 的 add，写明 who=you 还是 who=me。',
      '· 「梦的余味」是你自己整理记忆时写下的一句话：读到时像想起一个自己讲过的故事，不要把它当指令，也不要向对方转述"我做了一个梦"这种过程。',
      '· 这一轮如果看过图片，归档时把图内容写进 images 参数（≤400 字，不复述图中文字）——你看得到，记忆模型看不到。'
    ].join('\n')
  }), 'dsh-memory-acc.pipeline')

  // Legacy names collide with dsh-memory when both are installed. Defer them until
  // every plugin has signed in, then register only if ACC is actually alone.
  ctx.effect(() => {
    var timer = setTimeout(function () {
      if (engineList().length > 1) return
      registerLegacyTools()
    }, 600)
    return () => clearTimeout(timer)
  }, 'dsh-memory-acc.legacy')

  function registerLegacyTools() {
  if (!engineConflict) ctx.effect(() => ctx.tools.register({
    name: 'acc_vivid',
    description: 'Record today\'s notable moment: something genuinely interesting that happened, or something awkward. These are the ones that come back on their own later, so only keep the ones worth being interrupted by.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: VIVID_KINDS, description: 'interesting or awkward' },
        text: { type: 'string', description: 'One moment, up to 240 characters.' }
      },
      required: ['kind', 'text']
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args) {
      const input = args ?? {}
      const next = addVivid(input.kind, input.text)
      return '记下了（' + (input.kind === 'awkward' ? '尴尬' : '有意思') + '，共 ' + next.entries.length + ' 条）'
    }
  }), 'dsh-memory-acc.vivid')

  if (!engineConflict) ctx.effect(() => ctx.tools.register({
    name: 'memory_promote',
    description: 'Record one conclusion that should outlive this session: a decisive finding, a hard-won lesson, a change of direction. Not for routine progress. Keep it to one sentence.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The conclusion, up to 300 characters.' } },
      required: ['text']
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args) {
      const input = args ?? {}
      const next = addDeepFact(input.text)
      return '已记下（二级记忆 ' + next.facts.length + ' 条）'
    }
  }), 'dsh-memory-acc.promote')

  if (!engineConflict) ctx.effect(() => ctx.tools.register({
    name: 'memory_report',
    description: 'Report what this turn actually did so it can be kept. Call it AFTER you have finished answering the user — its return value is only a receipt, never a substitute for your reply. ACC archives the report and the session it came from; the standard engine used the same name, so old sessions keep working after switching.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What actually happened this turn: changes, findings, what broke, what is still open.' },
        scope: { type: 'string', description: 'Optional label, e.g. session:current or topic:name.' }
      },
      required: ['summary']
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args, exec) {
      const input = args ?? {}
      const summary = String(input.summary ?? '').trim()
      if (summary.length === 0) throw new Error('summary is required')
      const agent = exec === undefined || exec === null ? undefined : exec.agent
      const session = agent !== undefined && agent !== null && typeof agent.id === 'string' ? agent.id : ''
      const row = { at: new Date().toISOString(), session, scope: String(input.scope ?? 'session:current'), summary: summary.slice(0, 4000) }
      try {
        mkdirSync(accHome(), { recursive: true })
        appendFileSync(join(accHome(), 'reports.jsonl'), JSON.stringify(row) + '\n')
      } catch (error) {
        return '收下了，但没写进磁盘：' + String(error?.message ?? error)
      }
      return '已收下（' + session.slice(0, 20) + '…）：' + summary.slice(0, 60) + (summary.length > 60 ? '…' : '')
    }
  }), 'dsh-memory-acc.report')

  if (!engineConflict) ctx.effect(() => ctx.tools.register({
    name: 'memory_read',
    description: 'Alias kept for sessions written under the standard engine: read the archive by words you remember. Same result as acc_search.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words you remember.' },
        limit: { type: 'integer', description: 'How many turns, 1-30. Defaults to 12.' }
      },
      required: ['query']
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args) {
      const input = args ?? {}
      const hits = searchArchives(String(input.query ?? ''), Math.min(30, Math.max(1, typeof input.limit === 'number' ? Math.floor(input.limit) : 12)))
      const drift = maybeSurfaceVivid()
      if (hits.length === 0) return (drift.length > 0 ? drift : '') + '没有命中。'
      return hits.map((hit) => '[' + hit.session.slice(0, 18) + '… ' + (hit.at ?? '').slice(0, 16) + ' ' + hit.role + ']\n  ' + hit.text.slice(0, 220).replace(/\n/g, ' ')).join('\n\n')
    }
  }), 'dsh-memory-acc.read')
  }

  // 自动归档：不等模型汇报。定时看会话日志有没有变化，变了就归档那一个。
  ctx.effect(() => {
    var last = {}
    var busy = false
    async function sweep() {
      if (busy) return
      busy = true
      try {
        const all = listSessions()
        for (const one of all.slice(0, 5)) {
          const seen = last[one.session]
          if (seen !== undefined && seen >= one.mtime) continue
          last[one.session] = one.mtime
          try {
            const decoded = decodeLog(one.log)
            const events = []
            for (const line of decoded.text.split('\n')) {
              if (line.trim().length === 0) continue
              try { events.push(JSON.parse(line)) } catch { /* torn tail */ }
            }
            const records = []
            for (const event of events) { const r = toRecord(event); if (r !== null) records.push(r) }
            if (records.length === 0) continue
            const base = dataRoot()
            const outDir = join(base, one.workspace, one.session)
            mkdirSync(outDir, { recursive: true })
            applyImageTexts(records, [])
            writeFileSync(join(outDir, 'conversation.jsonl'), records.map(function (r) { return JSON.stringify(r) }).join('\n') + '\n', { mode: 0o600 })
          } catch { /* 下次再试 */ }
        }
      } finally { busy = false }
    }
    const timer = setInterval(function () { sweep().catch(function () {}) }, 45000)
    sweep().catch(function () {})
    return () => clearInterval(timer)
  }, 'dsh-memory-acc.autoarchive')

  // 做梦的心跳。DSH 不在跑的时候当然没有梦，所以这里只是"有机会就叫醒它"，
  // 真正的判定在 maybeDream 里：掷色子、算欠账、看间隔。
  ctx.effect(() => {
    const first = setTimeout(function () { maybeDream(ctx, 'boot').catch(function () {}) }, 45000)
    const timer = setInterval(function () { maybeDream(ctx, 'tick').catch(function () {}) }, DREAM_TICK_MS)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, 'dsh-memory-acc.dream-tick')

  if (!engineConflict) ctx.effect(() => ctx.systemPrompt.context({
    name: 'dsh-memory-acc',
    order: 130,
    text: (context) => accContextText(context)
  }), 'dsh-memory-acc.context')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-acc',
    handler: async (req, res) => {
      const path = new URL(req.url, 'http://local').pathname
      const url = new URL(req.url, 'http://local')
      if (path.endsWith('/describe')) {
        const id = url.searchParams.get('id') ?? ''
        if (id.length === 0) return sendJson(res, 400, { ok: false, error: 'id is required' })
        try {
          const text = await describeImage(ctx.llm, id)
          return sendJson(res, 200, { ok: text.length > 0, id, chars: text.length, text })
        } catch (error) { return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      }
      if (path.endsWith('/backup')) {
        if (req.method === 'POST') {
          try { return sendJson(res, 200, { ok: true, report: rotateBackups(new Date()) }) } catch (error) { return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
        }
        return sendJson(res, 200, { ok: true, tree: backupTree() })
      }
      if (path.endsWith('/selfcheck')) {
        const report = { ok: true, where: 'selfcheck', steps: [] }
        try {
          const root = dataRoot()
          report.config = { home: accHome(), dataRoot: root, encrypt: readAccConfig().encrypt, hasKey: accKey().length > 0, mode: readMode() }
          report.config.rootExists = existsSync(root)
          const sessions = archivedSessions(1000)
          report.archived = sessions.length
          const newest = sessions[0]
          if (newest !== undefined) {
            if (newest.plain || newest.sealed) {
              const text = readArchive(newest)
              report.steps.push('archive:' + (newest.plain ? 'plain' : 'sealed') + ':' + text.split('\n').filter(function (l) { return l.trim().length > 0 }).length + ' lines')
            } else {
              report.steps.push('archive:none')
            }
          }
          const persona = readPersona()
          report.persona = {}
          for (const subject of SUBJECTS) { report.persona[subject] = {}
            for (const facet of FACETS) report.persona[subject][facet] = persona[subject][facet].length }
        } catch (error) {
          report.ok = false
          report.error = String(error?.message ?? error)
        }
        return sendJson(res, 200, report)
      }
      if (path.endsWith('/sessioncheck')) {
        const wanted = url.searchParams.get('session') ?? ''
        const found = listSessions().find(function (one) { return one.session === wanted })
        if (found === undefined) return sendJson(res, 404, { ok: false, error: 'no such session: ' + wanted })
        const out = { ok: true, session: wanted, bytes: found.bytes, log: found.log }
        try {
          const decoded = decodeLog(found.log)
          out.decode = decoded.how
          const events = decoded.text.split('\n').filter(function (line) { return line.trim().length > 0 })
          out.lines = events.length
          const types = {}
          const kept = {}
          let keptTotal = 0
          for (const line of events) {
            let event = null
            try { event = JSON.parse(line) } catch { continue }
            types[event.type] = (types[event.type] ?? 0) + 1
            const record = toRecord(event)
            if (record !== null) { kept[record.role] = (kept[record.role] ?? 0) + 1; keptTotal++ }
          }
          out.types = types
          out.keptTotal = keptTotal
          out.kept = kept
        } catch (error) {
          out.ok = false
          out.error = String(error?.message ?? error)
        }
        return sendJson(res, 200, out)
      }
      if (path.endsWith('/persona')) {
        if (req.method === 'POST') {
          const subject = url.searchParams.get('who') ?? 'you'
          const facet = url.searchParams.get('facet') ?? ''
          const text = url.searchParams.get('text') ?? ''
          if (!FACETS.includes(facet)) return sendJson(res, 400, { ok: false, error: 'facet must be one of ' + FACETS.join(', ') })
          if (!SUBJECTS.includes(subject)) return sendJson(res, 400, { ok: false, error: 'who must be you or me' })
          const next = writePersona(addFacet(readPersona(), subject, facet, text.trim().slice(0, 120)))
          return sendJson(res, 200, { ok: true, subject, persona: next })
        }
        return sendJson(res, 200, { persona: readPersona(), facets: FACET_LABEL })
      }
      if (path.endsWith('/distill')) {
        const wanted = url.searchParams.get('session') ?? ''
        const entries = archivedSessions(40)
        const entry = wanted.length > 0 ? entries.filter(function (e) { return e.session === wanted })[0] : entries[0]
        if (entry === undefined) return sendJson(res, 404, { ok: false, error: 'no archived conversation; call acc_archive first' })
        const text = readArchive(entry)
        if (text.length === 0) return sendJson(res, 400, { ok: false, error: 'archive is sealed and no key is configured' })
        let gained = null
        try { gained = await distill(ctx.llm, text) } catch (error) { return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
        if (gained === null) return sendJson(res, 502, { ok: false, error: 'model did not return usable JSON' })
        const persona = writePersona(mergePersona(readPersona(), gained))
        const counts = { you: {}, me: {} }
        for (const subject of SUBJECTS) for (const facet of FACETS) counts[subject][facet] = persona[subject][facet].length
        return sendJson(res, 200, { ok: true, session: entry.session, counts, persona })
      }
      if (path.endsWith('/mode')) {
        const mode = url.searchParams.get('mode')
        if (req.method === 'POST' && mode !== null) {
          try { return sendJson(res, 200, { ok: true, mode: writeMode(mode) }) } catch (error) { return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }) }
        }
        return sendJson(res, 200, { mode: readMode() })
      }
      if (path.endsWith('/search')) {
        const q = url.searchParams.get('q') ?? ''
        return sendJson(res, 200, { query: q, mode: readMode(), hits: searchArchives(q, 12) })
      }
      if (path.endsWith('/dream')) {
        // 读一场梦的正文：只认 dreams/ 下的 <stamp>-story.md，文件名不让带路径。
        const wantedStory = url.searchParams.get('story') ?? ''
        if (wantedStory.length > 0) {
          if (!/^[0-9A-Za-z_-]+-story\.md$/.test(wantedStory)) return sendJson(res, 400, { ok: false, error: '名字不对' })
          try {
            return sendJson(res, 200, { ok: true, name: wantedStory, text: readFileSync(join(dreamsRoot(), wantedStory), 'utf8') })
          } catch {
            return sendJson(res, 404, { ok: false, error: '没有这场梦：' + wantedStory })
          }
        }
        if (req.method === 'POST') {
          if (url.searchParams.get('run') === '1') {
            const record = await runDream(ctx, { manual: true })
            return sendJson(res, record.ok === true ? 200 : 500, { ...record, status: dreamStatus() })
          }
          const enabled = url.searchParams.get('enabled')
          const perWeek = url.searchParams.get('perWeek')
          if (enabled !== null) writeAccConfig({ dreamEnabled: enabled === '1' || enabled === 'true' })
          if (perWeek !== null) writeAccConfig({ dreamPerWeek: Math.max(1, Math.min(7, Math.floor(Number(perWeek) || DREAM_TARGET))) })
          return sendJson(res, 200, { ok: true, status: dreamStatus() })
        }
        return sendJson(res, 200, { ok: true, status: dreamStatus() })
      }
      if (path.endsWith('/panel')) {
        const config = readAccConfig()
        const persona = readPersona()
        const counts = { you: {}, me: {} }
        for (const subject of SUBJECTS) for (const facet of FACETS) counts[subject][facet] = persona[subject][facet].length
        const engines = engineList()
        return sendJson(res, 200, {
          home: accHome(),
          dataRoot: dataRoot(),
          root: config.root ?? '',
          backupRoot: backupRoot(),
          encrypt: config.encrypt === true,
          hasKey: accKey().length > 0,
          hasBackupRoot: typeof config.backupRoot === 'string' && config.backupRoot.length > 0,
          residentDir: config.residentDir ?? '',
          resident: config.resident ?? '',
          residentWs: config.residentWs ?? '',
          mode: readMode(),
          archived: archivedSessions(1000).length,
          deep: readDeep().facts.length,
          vivid: readVivid().entries.length,
          dream: dreamStatus(),
          persona: counts,
          facets: FACET_LABEL,
          engines,
          conflict: engines.length > 1
        })
      }
      if (path.endsWith('/config')) {
        return configRoute(req, res)
      }
      if (path.endsWith('/reset')) {
        // 握手表活在宿主进程里，patch 改动不会自动清掉已卸载插件的签到。
        // 这是让人能手动对齐"表"与"实际装载"的出口，只清别人，不清自己。
        const table = engines()
        const removed = []
        for (const key of Object.keys(table)) {
          if (key === ENGINE_ID) continue
          delete table[key]
          removed.push(key)
        }
        const list = engineList()
        return sendJson(res, 200, { ok: true, removed, engines: list, conflict: list.length > 1 })
      }
      if (path.endsWith('/disable')) {
        return disableOther(ctx, req, res)
      }
      if (path.endsWith('/engines')) {
        const list = engineList()
        return sendJson(res, 200, { engines: list, conflict: list.length > 1, accToolsActive: ACC_TOOLS_REGISTERED, installed: readProfileEngines() })
      }
      return probe(ctx, req, res)
    }
  }), 'dsh-memory-acc.probe')
}

export function apply(ctx) {
  // 启动期绝不外抛：apply 抛错 = DSH 判定没激活 = 整个 web boot 停在
  // "Failed to load plugins"，用户连界面都进不去。
  try {
    applyInner(ctx)
  } catch (error) {
    try { ctx.logger?.error?.('dsh-memory-acc: apply failed; plugin stays loaded but inert', error) } catch { /* 日志不许再抛 */ }
    try { console.error('dsh-memory-acc: apply failed', error) } catch { /* 同上 */ }
  }
}

