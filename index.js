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
    : join(process.env.HOME ?? '.', '.dsh')
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
  const cli = spawnSync('zstd', ['-dc', path], { maxBuffer: 512 * 1024 * 1024 })
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
const VERSION = '0.1.0'
const ENGINE_ID = 'dsh-memory-acc'
const REGISTRY = Symbol.for('dsh.memory.engines')

function engines() {
  if (globalThis[REGISTRY] === undefined) globalThis[REGISTRY] = {}
  return globalThis[REGISTRY]
}

function engineList() {
  return Object.entries(engines()).map(([id, info]) => ({ id, kind: info.kind, version: info.version, at: info.at }))
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

async function disableOther(ctx, req, res) {
  const url = new URL(req.url, 'http://local')
  const target = String(url.searchParams.get('target') ?? '').trim()
  const dir = process.env.DSH_PROFILE_DIR ?? ''
  if (dir.length === 0) return sendJson(res, 400, { ok: false, error: 'DSH_PROFILE_DIR is not set; cannot locate the profile patch' })
  const file = join(dir, 'cordis.patch.yml')
  if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: 'no cordis.patch.yml in ' + dir })
  let YAML
  try { YAML = await import('yaml') } catch (error) { return sendJson(res, 500, { ok: false, error: 'yaml unavailable: ' + String(error?.message ?? error) }) }
  try {
    const doc = YAML.parse(readFileSync(file, 'utf8')) ?? []
    const list = Array.isArray(doc) ? doc : []
    let changed = false
    for (const entry of list) {
      const rows = Array.isArray(entry?.insert) ? entry.insert : []
      for (const row of rows) {
        const hit = row?.id === target || row?.name === target
        if (target.length > 0 && !hit) continue
        row.disabled = true
        changed = true
      }
      if (entry?.id === target || entry?.name === target) { entry.disabled = true; changed = true }
    }
    if (!changed) return sendJson(res, 200, { ok: false, error: 'target not found: ' + target })
    writeFileSync(file, YAML.stringify(list))
    return sendJson(res, 200, { ok: true, disabled: target, file, note: 'HMR reconciles patch edits live' })
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
  if (lines.length === 0 && deepLines.length === 0) return ''
  const parts = []
  if (lines.length > 0) parts.push(lines.join('\n'))
  if (deepLines.length > 0) parts.push('已定下的结论：\n' + deepLines.join('\n'))
  const body = '记忆（ACC）：这些是印象，不是档案条文。\n' + parts.join('\n')
    + '\n需要更早的具体内容时用 acc_search 或 memory_read 去找，别凭印象编；找不到就说没有印象。'
  // A stray {{ would be read as an interpolation reference and throw during assembly.
  return clipText(body, 900).replaceAll('{{', '{ {')
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
  chmodSync(file, 0o444)
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
  chmodSync(manifest, 0o444)
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
  chmodSync(file, 0o444)
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
    chmodSync(reason, 0o444)
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

export function apply(ctx) {
  // Mutual exclusion, enforced where it can actually be observed: when another
  // memory engine signed in first, ACC keeps its reporting route and drops its
  // tools, so two memory chains never run in one turn.
  const clash = engineList().length > 1
  if (clash) {
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

  if (!clash) ctx.effect(() => ctx.tools.register({
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
      return hits.map((hit) => '[' + hit.session.slice(0, 18) + '… ' + (hit.at ?? '').slice(0, 16) + ' ' + hit.role + '] 得分 ' + hit.score + '\n  ' + hit.text.slice(0, 220).replace(/\n/g, ' ')).join('\n\n')
    }
  }), 'dsh-memory-acc.search')

  if (!clash) ctx.effect(() => ctx.tools.register({
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

  // --- compatibility aliases ---------------------------------------------------
  // A session that ran under the standard engine carries its contract in history:
  // every turn ends with memory_report. Switching the engine must not break those
  // sessions, so the same names exist here and mean the ACC thing.
  if (!clash) ctx.effect(() => ctx.systemPrompt.section({
    name: 'dsh-memory-acc:pipeline',
    order: 700,
    text: () => [
      '记忆线路（ACC）：',
      '· 归档是自动的：ACC 自己从会话日志提取，你不需要每轮汇报任何东西。',
      '· 唯一需要你补的是图片：这一轮如果看过图，把图内容写进 acc_archive 的 images 参数（≤400 字，不复述图中文字）。',
      '· 需要旧内容时用 acc_search 或 memory_read：给几个记得的词就够。',
      '· 回忆要用"印象"的口吻，不是"存储报告"：说「我对那张图的印象就这些」，不要解释"这是归档的描述""我没有原件了"这类存储细节——对方要的是你的记忆，不是你的结构。',
      '· 想留一句对人的印象，用 acc_persona 的 add，写明 who=you 还是 who=me。',
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
  if (!clash) ctx.effect(() => ctx.tools.register({
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

  if (!clash) ctx.effect(() => ctx.tools.register({
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

  if (!clash) ctx.effect(() => ctx.tools.register({
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
      if (hits.length === 0) return '没有命中。'
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

  if (!clash) ctx.effect(() => ctx.systemPrompt.context({
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
        return sendJson(res, 200, { engines: list, conflict: list.length > 1, accToolsActive: list.length < 2 })
      }
      return probe(ctx, req, res)
    }
  }), 'dsh-memory-acc.probe')
}
