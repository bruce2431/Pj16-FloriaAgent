import { createSocket, type RemoteInfo } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { remoteIPv4 } from './utils.js'

const MDNS_NAME = 'floria.local'
const MDNS_PORT = 5353
const MDNS_GROUP = '224.0.0.251'
const MDNS_RECORD_TTL = 300

const mdnsSockets = new Map<string, ReturnType<typeof createSocket>>()
const mdnsPendingBinds = new Set<string>()
let mdnsWatchTimer: ReturnType<typeof setInterval> | null = null
const MDNS_WATCH_INTERVAL = 30_000
let mdnsAnnounceTimer: ReturnType<typeof setInterval> | null = null
const MDNS_ANNOUNCE_INTERVAL = 60_000
const mdnsAnnounceSeen = new Map<string, number>()

const MDNS_NAME_ENC = Buffer.concat([
  Buffer.from([6]),
  Buffer.from('floria', 'latin1'),
  Buffer.from([5]),
  Buffer.from('local', 'latin1'),
  Buffer.from([0]),
])

interface MdnsIf {
  address: string
  netmask: string
}

function mdnsLanIfs(): MdnsIf[] {
  const out: MdnsIf[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ address: ni.address, netmask: ni.netmask })
    }
  }
  return out.filter(
    (x) =>
      !x.address.startsWith('169.254.') &&
      !/^198\.18\./.test(x.address) &&
      !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(x.address),
  )
}

function mdnsLanAddrs(): string[] {
  return mdnsLanIfs().map((x) => x.address)
}

function mdnsReadName(buf: Buffer, offset: number): { name: string; next: number } | null {
  const labels: string[] = []
  let ptr = offset
  let next = -1
  for (let i = 0; i < 32; i++) {
    const len = buf[ptr]
    if (len === undefined) return null
    if (len === 0) {
      return { name: labels.join('.'), next: next === -1 ? ptr + 1 : next }
    }
    if ((len & 0xc0) === 0xc0) {
      if (next === -1) next = ptr + 2
      const target = ((len & 0x3f) << 8) | buf[ptr + 1]
      if (target === undefined) return null
      ptr = target
      continue
    }
    labels.push(buf.subarray(ptr + 1, ptr + 1 + len).toString('latin1'))
    ptr += 1 + len
  }
  return null
}

function mdnsAddrRecord(nameField: Buffer, ip: string, cls: number): Buffer {
  const rec = Buffer.alloc(nameField.length + 14)
  nameField.copy(rec, 0)
  rec.writeUInt16BE(1, nameField.length)
  rec.writeUInt16BE(cls, nameField.length + 2)
  rec.writeUInt32BE(MDNS_RECORD_TTL, nameField.length + 4)
  rec.writeUInt16BE(4, nameField.length + 8)
  const octets = ip.split('.').map(Number)
  for (let i = 0; i < 4; i++) rec[nameField.length + 10 + i] = octets[i] & 0xff
  return rec
}

export function mdnsStart(): void {
  if (mdnsSockets.size) return
  for (const ip of mdnsLanAddrs()) mdnsStartOne(ip)
  if (!mdnsWatchTimer) mdnsWatchTimer = setInterval(mdnsWatch, MDNS_WATCH_INTERVAL)
  if (!mdnsAnnounceTimer) {
    mdnsAnnounceTimer = setInterval(() => {
      for (const ip of mdnsSockets.keys()) mdnsAnnounceOne(ip, false)
    }, MDNS_ANNOUNCE_INTERVAL)
  }
}

function mdnsStartOne(ip: string): void {
  if (mdnsPendingBinds.has(ip) || mdnsSockets.has(ip)) return
  mdnsPendingBinds.add(ip)
  const sock = createSocket({ type: 'udp4', reuseAddr: true })
  sock.on('error', () => {
    mdnsPendingBinds.delete(ip)
    try {
      sock.close()
    } catch {
      /* 忽略 */
    }
    if (mdnsSockets.get(ip) === sock) mdnsSockets.delete(ip)
    console.error(`[gateway] mDNS 应答器启动失败（${ip}，该接口回落 IP 直连）`)
  })
  sock.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
    try {
      mdnsHandleQuery(sock, ip, msg, rinfo)
    } catch {
      /* 忽略坏包 */
    }
  })
  sock.bind(MDNS_PORT, ip, () => {
    mdnsPendingBinds.delete(ip)
    try {
      sock.addMembership(MDNS_GROUP, ip)
      mdnsSockets.set(ip, sock)
      console.log(`[gateway] mDNS 应答器就绪：floria.local → ${ip}`)
      for (const delay of [0, 1000, 2000]) setTimeout(() => mdnsAnnounceOne(ip, false), delay)
      console.log(`[gateway] mDNS announce 保活启动：floria.local → ${ip}（多播 + 子网单播，3 连发）`)
    } catch (e) {
      try {
        sock.close()
      } catch {
        /* 忽略 */
      }
      if (mdnsSockets.get(ip) === sock) mdnsSockets.delete(ip)
      console.error(`[gateway] mDNS 入组失败（${ip}）: ${(e as Error).message}`)
    }
  })
}

function mdnsWatch(): void {
  const cur = new Set(mdnsLanAddrs())
  let changed = false
  for (const [ip, sock] of [...mdnsSockets]) {
    if (cur.has(ip)) continue
    changed = true
    try {
      sock.close()
    } catch {
      /* 忽略 */
    }
    mdnsSockets.delete(ip)
  }
  for (const ip of cur) {
    if (mdnsSockets.has(ip) || mdnsPendingBinds.has(ip)) continue
    changed = true
    mdnsStartOne(ip)
  }
  if (changed) console.log(`[gateway] mDNS 接口变化，现绑：${[...mdnsSockets.keys()].join('/') || '无'}`)
}

function mdnsHandleQuery(
  sock: ReturnType<typeof createSocket>,
  bindIp: string,
  msg: Buffer,
  rinfo: RemoteInfo,
): void {
  if (msg.length < 12 + 5) return
  if (msg.readUInt16BE(2) & 0x8000) return
  const lastSeen = mdnsAnnounceSeen.get(rinfo.address) ?? 0
  if (Date.now() - lastSeen > 30_000) {
    mdnsAnnounceSeen.set(rinfo.address, Date.now())
    console.log(`[gateway] mDNS 单播回推 announce → ${rinfo.address}（30s/源节流）`)
    mdnsAnnounceToPeer(bindIp, rinfo.address)
  }
  const qdcount = msg.readUInt16BE(4)
  console.log(`[gateway] mDNS 查询到达：${rinfo.address}:${rinfo.port}（QD=${qdcount}）`)
  if (qdcount < 1) return
  let off = 12
  let hit = -1
  let hitType = 1
  let hitClass = 1
  for (let qi = 0; qi < qdcount && off + 1 < msg.length; qi++) {
    const parsed = mdnsReadName(msg, off)
    if (!parsed || parsed.next + 4 > msg.length) return
    const qtype = msg.readUInt16BE(parsed.next)
    const qclass = msg.readUInt16BE(parsed.next + 2)
    if (hit < 0 && parsed.name.toLowerCase() === MDNS_NAME && (qtype === 1 || qtype === 255)) {
      hit = qi
      hitType = qtype
      hitClass = qclass & 0x7fff
    }
    off = parsed.next + 4
  }
  if (hit < 0) return
  const addrs = [bindIp]
  const header = Buffer.alloc(12)
  header.writeUInt16BE(rinfo.port === MDNS_PORT ? 0 : msg.readUInt16BE(0), 0)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(addrs.length, 6)
  const qtail = Buffer.alloc(4)
  qtail.writeUInt16BE(hitType, 0)
  qtail.writeUInt16BE(hitClass || 1, 2)
  const question = Buffer.concat([MDNS_NAME_ENC, qtail])
  const namePtr = Buffer.from([0xc0, 0x0c])
  const reply = Buffer.concat([header, question, ...addrs.map((ip) => mdnsAddrRecord(namePtr, ip, 1))])
  sock.send(reply, MDNS_PORT, MDNS_GROUP, () => {})
  sock.send(reply, rinfo.port, rinfo.address, () => {})
}

function mdnsAnnouncePacket(bindIp: string): Buffer {
  const question = Buffer.concat([MDNS_NAME_ENC, Buffer.from([0, 1, 0, 1])])
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(1, 6)
  return Buffer.concat([header, question, mdnsAddrRecord(Buffer.from([0xc0, 0x0c]), bindIp, 1)])
}

function mdnsMulticastAnnouncePacket(bindIp: string): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(0, 4)
  header.writeUInt16BE(1, 6)
  return Buffer.concat([header, mdnsAddrRecord(MDNS_NAME_ENC, bindIp, 0x8001)])
}

const ipToU32 = (s: string) =>
  s.split('.').reduce((acc, o) => (acc << 8) + (Number(o) & 0xff), 0) >>> 0

function mdnsSameSubnet(a: string, b: string, netmask: string): boolean {
  const m = ipToU32(netmask)
  return ((ipToU32(a) & m) >>> 0) === ((ipToU32(b) & m) >>> 0)
}

function mdnsSubnetPeers(ip: string, netmask: string): string[] {
  const ipN = ipToU32(ip)
  const maskN = ipToU32(netmask)
  const base = (ipN & maskN) >>> 0
  const size = (~maskN >>> 0) + 1
  if (size > 512) return []
  const out: string[] = []
  for (let n = 1; n < size - 1; n++) {
    const a = (base + n) >>> 0
    if (a === ipN) continue
    out.push([(a >>> 24) & 0xff, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff].join('.'))
  }
  return out
}

function mdnsAnnounceOne(bindIp: string, log: boolean): void {
  const sock = mdnsSockets.get(bindIp)
  if (!sock) return
  sock.send(mdnsMulticastAnnouncePacket(bindIp), MDNS_PORT, MDNS_GROUP, () => {})
  const netmask = mdnsLanIfs().find((x) => x.address === bindIp)?.netmask
  if (!netmask) return
  const pkt = mdnsAnnouncePacket(bindIp)
  const peers = mdnsSubnetPeers(bindIp, netmask)
  for (const peer of peers) sock.send(pkt, MDNS_PORT, peer, () => {})
  if (log) {
    console.log(`[gateway] mDNS announce：floria.local → ${bindIp}（多播 + 单播 ${peers.length} 地址）`)
  }
}

function mdnsAnnounceToPeer(bindIp: string, peer: string): void {
  const sock = mdnsSockets.get(bindIp)
  if (!sock) return
  sock.send(mdnsAnnouncePacket(bindIp), MDNS_PORT, peer, () => {})
}

export function mdnsPushToReachableClient(remoteIpRaw: string): void {
  const remoteIp = remoteIPv4(remoteIpRaw)
  if (!remoteIp) return
  if (remoteIp.startsWith('127.')) return
  for (const bindIp of mdnsSockets.keys()) {
    const netmask = mdnsLanIfs().find((x) => x.address === bindIp)?.netmask
    if (!netmask || !mdnsSameSubnet(remoteIp, bindIp, netmask)) continue
    const lastSeen = mdnsAnnounceSeen.get(remoteIp) ?? 0
    if (Date.now() - lastSeen > 30_000) {
      mdnsAnnounceSeen.set(remoteIp, Date.now())
      console.log(`[gateway] mDNS 定向推（直连客户端 ${remoteIp}）：floria.local → 3 连发`)
      for (const delay of [0, 1000, 2000]) {
        setTimeout(() => mdnsAnnounceToPeer(bindIp, remoteIp), delay)
      }
    }
    return
  }
}

export function mdnsStop(): void {
  if (mdnsWatchTimer) {
    clearInterval(mdnsWatchTimer)
    mdnsWatchTimer = null
  }
  if (mdnsAnnounceTimer) {
    clearInterval(mdnsAnnounceTimer)
    mdnsAnnounceTimer = null
  }
  mdnsAnnounceSeen.clear()
  mdnsPendingBinds.clear()
  for (const sock of mdnsSockets.values()) {
    try {
      sock.close()
    } catch {
      /* 忽略 */
    }
  }
  mdnsSockets.clear()
}
