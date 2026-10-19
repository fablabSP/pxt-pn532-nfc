/**
 * PN532 NFC/RFID reader over I2C for micro:bit V2.
 *
 * Wiring: SDA -> P20, SCL -> P19, VCC -> 3V (or 5V), GND -> GND.
 * Module switches: I2C mode (SEL0 = ON / 1, SEL1 = OFF / 0).
 *
 * This extension depends on "core" only. It does not use radio, bluetooth
 * or any yotta config, so it can be combined with BLE HID extensions.
 */
//% color="#2E7D9A" weight=90 icon="" block="NFC"
//% groups='["Setup", "Read", "Card data", "NDEF", "Advanced"]'
namespace nfc {
    const ADDR = 0x24

    // PN532 commands
    const CMD_GET_FIRMWARE = 0x02
    const CMD_SAM_CONFIG = 0x14
    const CMD_RF_CONFIG = 0x32
    const CMD_IN_DATA_EXCHANGE = 0x40
    const CMD_IN_LIST_PASSIVE = 0x4A

    // Card commands (sent through InDataExchange)
    const MF_AUTH_A = 0x60
    const MF_READ = 0x30
    const MF_WRITE = 0xA0
    const UL_WRITE = 0xA2

    const CMD_TIMEOUT_MS = 1000

    let initDone = false
    let busy = false
    let pollMs = 200
    let pollerStarted = false
    let authKey: Buffer = null

    // Info about the most recently detected card
    let lastUid: Buffer = null
    let lastSelRes = -1

    // ---------------------------------------------------------------
    // Low level transport
    // ---------------------------------------------------------------

    function lock(): void {
        while (busy) basic.pause(1)
        busy = true
    }

    function unlock(): void {
        busy = false
    }

    function waitReady(timeoutMs: number): boolean {
        const start = control.millis()
        while (true) {
            const s = pins.i2cReadBuffer(ADDR, 1)
            if (s.length > 0 && (s[0] & 0x01) == 1) return true
            if (control.millis() - start > timeoutMs) return false
            basic.pause(2)
        }
    }

    function buildFrame(cmd: number, params: Buffer): Buffer {
        const n = params ? params.length : 0
        const len = n + 2 // TFI + CMD + params
        const f = pins.createBuffer(n + 9)
        f[0] = 0x00
        f[1] = 0x00
        f[2] = 0xFF
        f[3] = len
        f[4] = (0x100 - len) & 0xFF
        f[5] = 0xD4
        f[6] = cmd
        let sum = 0xD4 + cmd
        for (let i = 0; i < n; i++) {
            f[7 + i] = params[i]
            sum += params[i]
        }
        f[7 + n] = (0x100 - (sum & 0xFF)) & 0xFF
        f[8 + n] = 0x00
        return f
    }

    function checkAck(buf: Buffer): boolean {
        // buf[0] is the status byte
        return buf.length >= 7 &&
            buf[1] == 0x00 && buf[2] == 0x00 && buf[3] == 0xFF &&
            buf[4] == 0x00 && buf[5] == 0xFF && buf[6] == 0x00
    }

    /**
     * Parse a response frame read from I2C (first byte is status).
     * Returns the data after TFI+CMD, or null if invalid.
     */
    function parseResponse(buf: Buffer, cmd: number): Buffer {
        // find preamble 00 FF after the status byte
        let i = 1
        while (i < buf.length - 1 && !(buf[i] == 0x00 && buf[i + 1] == 0xFF)) i++
        if (i >= buf.length - 1) return null
        i += 2
        if (i + 2 > buf.length) return null
        const len = buf[i]
        const lcs = buf[i + 1]
        if (((len + lcs) & 0xFF) != 0) return null
        i += 2
        if (len < 2 || i + len + 1 > buf.length) return null
        if (buf[i] != 0xD5 || buf[i + 1] != cmd + 1) return null
        let sum = 0
        for (let k = 0; k < len; k++) sum += buf[i + k]
        if (((sum + buf[i + len]) & 0xFF) != 0) return null
        return buf.slice(i + 2, len - 2)
    }

    /**
     * Send a command and return the response data (without TFI/CMD),
     * or null on any error or timeout. maxData is the largest data length expected.
     */
    function command(cmd: number, params: Buffer, maxData: number): Buffer {
        lock()
        let result: Buffer = null
        pins.i2cWriteBuffer(ADDR, buildFrame(cmd, params))
        if (waitReady(CMD_TIMEOUT_MS)) {
            const ack = pins.i2cReadBuffer(ADDR, 7)
            if (checkAck(ack) && waitReady(CMD_TIMEOUT_MS)) {
                // status + preamble(3) + len + lcs + tfi + cmd + data + dcs + post
                const resp = pins.i2cReadBuffer(ADDR, maxData + 10)
                result = parseResponse(resp, cmd)
            }
        }
        unlock()
        return result
    }

    function bytes(values: number[]): Buffer {
        const b = pins.createBuffer(values.length)
        for (let i = 0; i < values.length; i++) b[i] = values[i]
        return b
    }

    function ensureInit(): boolean {
        if (!initDone) init()
        return initDone
    }

    function hex(b: Buffer): string {
        const digits = "0123456789ABCDEF"
        let s = ""
        for (let i = 0; i < b.length; i++) {
            s += digits.charAt(b[i] >> 4) + digits.charAt(b[i] & 0x0F)
        }
        return s
    }

    function hexVal(c: string): number {
        const i = "0123456789ABCDEF".indexOf(c.toUpperCase())
        return i
    }

    function bufToText(b: Buffer, start: number, end: number): string {
        let s = ""
        for (let i = start; i < end; i++) {
            const c = b[i]
            if (c == 0) break
            s += String.fromCharCode(c)
        }
        return s
    }

    /**
     * Select a card in the field. Updates lastUid / lastSelRes.
     * Returns true if a card was found.
     */
    function detect(): boolean {
        if (!ensureInit()) return false
        const r = command(CMD_IN_LIST_PASSIVE, bytes([0x01, 0x00]), 20)
        // r: NbTg Tg SENS_RES(2) SEL_RES UIDLen UID...
        if (!r || r.length < 6 || r[0] == 0) {
            lastUid = null
            lastSelRes = -1
            return false
        }
        const uidLen = r[5]
        if (r.length < 6 + uidLen) {
            lastUid = null
            return false
        }
        lastSelRes = r[4]
        lastUid = r.slice(6, uidLen)
        return true
    }

    function isClassic(): boolean {
        return lastUid != null && lastUid.length == 4 && (lastSelRes & 0x08) != 0
    }

    function isNtag(): boolean {
        return lastUid != null && lastUid.length == 7 && lastSelRes == 0x00
    }

    function exchange(data: Buffer, maxData: number): Buffer {
        const p = pins.createBuffer(data.length + 1)
        p[0] = 0x01 // target number
        p.write(1, data)
        const r = command(CMD_IN_DATA_EXCHANGE, p, maxData + 1)
        if (!r || r.length < 1 || r[0] != 0x00) return null
        return r.slice(1)
    }

    function authBlock(block: number): boolean {
        if (!authKey) {
            authKey = pins.createBuffer(6)
            authKey.fill(0xFF)
        }
        const d = pins.createBuffer(12)
        d[0] = MF_AUTH_A
        d[1] = block
        d.write(2, authKey)
        d.write(8, lastUid.slice(0, 4))
        return exchange(d, 0) != null
    }

    function safeClassicBlock(block: number): boolean {
        // Never touch block 0 (manufacturer) or sector trailers (keys).
        return block >= 1 && block <= 63 && ((block + 1) % 4) != 0
    }

    function readPages(page: number): Buffer {
        // MIFARE/NTAG read returns 16 bytes (1 classic block or 4 NTAG pages)
        const r = exchange(bytes([MF_READ, page]), 16)
        if (!r || r.length < 16) return null
        return r.slice(0, 16)
    }

    // ---------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------

    /**
     * Start the PN532 over I2C. Safe to call more than once.
     */
    //% block="init NFC (PN532 I2C)"
    //% blockId=pn532_init group="Setup" weight=100
    export function init(): void {
        // A first write wakes the PN532 if it is in low power mode.
        // SAMConfiguration: normal mode, timeout 1 s, use IRQ pin.
        const sam = command(CMD_SAM_CONFIG, bytes([0x01, 0x14, 0x01]), 4)
        if (!sam) {
            // retry once, the first frame after power up is often lost
            basic.pause(50)
            if (!command(CMD_SAM_CONFIG, bytes([0x01, 0x14, 0x01]), 4)) {
                initDone = false
                return
            }
        }
        // RFConfiguration item 5 (MaxRetries): ATR 0xFF, PSL 0x01, passive activation 2.
        // A small passive retry count keeps "card detected" quick when no card is there.
        command(CMD_RF_CONFIG, bytes([0x05, 0xFF, 0x01, 0x02]), 4)
        initDone = true
    }

    /**
     * True if the PN532 answers on I2C.
     */
    //% block="NFC module connected"
    //% blockId=pn532_connected group="Setup" weight=90
    export function isConnected(): boolean {
        return command(CMD_GET_FIRMWARE, null, 8) != null
    }

    /**
     * Firmware version text, for example "PN532 v1.6". Empty if not connected.
     */
    //% block="NFC firmware version"
    //% blockId=pn532_firmware group="Setup" weight=80
    export function firmwareVersion(): string {
        const r = command(CMD_GET_FIRMWARE, null, 8)
        if (!r || r.length < 4) return ""
        return "PN5" + hex(r.slice(0, 1)) + " v" + r[1] + "." + r[2]
    }

    // ---------------------------------------------------------------
    // Read
    // ---------------------------------------------------------------

    /**
     * True if a card or tag is near the reader.
     */
    //% block="NFC card detected"
    //% blockId=pn532_present group="Read" weight=100
    export function cardPresent(): boolean {
        return detect()
    }

    /**
     * UID of the card as hex text (for example "04A1B2C3"). Empty if no card.
     */
    //% block="NFC card UID"
    //% blockId=pn532_uid group="Read" weight=90
    export function readUID(): string {
        if (!detect()) return ""
        return hex(lastUid)
    }

    /**
     * Type of the last detected card: "MIFARE Classic", "NTAG" or "Unknown".
     */
    //% block="NFC card type"
    //% blockId=pn532_type group="Read" weight=80
    export function cardType(): string {
        if (!detect()) return ""
        if (isClassic()) return "MIFARE Classic"
        if (isNtag()) return "NTAG"
        return "Unknown"
    }

    /**
     * Runs once each time a card is tapped. The same card must be removed
     * before it triggers again.
     */
    //% block="on NFC card detected"
    //% blockId=pn532_on_card group="Read" weight=70
    //% draggableParameters=reporter
    export function onCardDetected(handler: (uid: string) => void): void {
        if (pollerStarted) return
        pollerStarted = true
        control.inBackground(function () {
            let current = ""
            let missed = 0
            while (true) {
                const uid = readUID()
                if (uid == "") {
                    missed++
                    // need 2 empty polls in a row before we accept the card is gone
                    if (missed >= 2) current = ""
                } else {
                    missed = 0
                    if (uid != current) {
                        current = uid
                        handler(uid)
                    }
                }
                basic.pause(pollMs)
            }
        })
    }

    // ---------------------------------------------------------------
    // Card data (MIFARE Classic)
    // ---------------------------------------------------------------

    /**
     * Read a MIFARE Classic block (16 bytes) as text.
     * Block 0 and sector trailers are refused.
     */
    //% block="read text from NFC block $blk"
    //% blockId=pn532_read_block_text group="Card data" weight=100
    //% blk.min=1 blk.max=62 blk.defl=4
    export function readBlockText(blk: number): string {
        const b = readBlock(blk)
        if (!b) return ""
        return bufToText(b, 0, 16)
    }

    /**
     * Write up to 16 characters to a MIFARE Classic block.
     * Block 0 and sector trailers are refused so cards cannot be bricked.
     */
    //% block="write text $text to NFC block $blk"
    //% blockId=pn532_write_block_text group="Card data" weight=90
    //% blk.min=1 blk.max=62 blk.defl=4 text.defl="hello"
    export function writeBlockText(blk: number, text: string): boolean {
        const b = pins.createBuffer(16)
        const n = Math.min(16, text.length)
        for (let i = 0; i < n; i++) b[i] = text.charCodeAt(i) & 0xFF
        return writeBlock(blk, b)
    }

    // ---------------------------------------------------------------
    // NDEF (NTAG / Ultralight, phone friendly)
    // ---------------------------------------------------------------

    /**
     * Read the first NDEF Text record from an NTAG sticker. Empty if none.
     */
    //% block="read NDEF text from NFC tag"
    //% blockId=pn532_read_ndef group="NDEF" weight=100
    export function readNDEFText(): string {
        if (!detect() || !isNtag()) return ""
        // Read user memory starting at page 4, 16 bytes at a time
        const maxBytes = 144
        const mem = pins.createBuffer(maxBytes)
        let have = 0
        let need = 16
        let page = 4
        while (have < need && have < maxBytes) {
            const chunk = readPages(page)
            if (!chunk) return ""
            mem.write(have, chunk)
            have += 16
            page += 4
            if (have == 16) {
                // find the NDEF TLV once we have the first chunk to size the read
                const t = findNdefTlv(mem, have)
                if (t < 0) return ""
                const len = mem[t + 1]
                need = len == 0xFF ? maxBytes : Math.min(maxBytes, t + 2 + len)
            }
        }
        const t = findNdefTlv(mem, have)
        if (t < 0) return ""
        let msgStart = t + 2
        let msgLen = mem[t + 1]
        if (msgLen == 0xFF) {
            msgLen = (mem[t + 2] << 8) | mem[t + 3]
            msgStart = t + 4
        }
        return parseTextRecord(mem, msgStart, Math.min(have, msgStart + msgLen))
    }

    /**
     * Write a single NDEF Text record (language "en") to an NTAG sticker.
     * A phone can read it. Up to 130 characters.
     */
    //% block="write NDEF text $text to NFC tag"
    //% blockId=pn532_write_ndef group="NDEF" weight=90
    export function writeNDEFText(text: string): boolean {
        if (!detect() || !isNtag()) return false
        const n = Math.min(130, text.length)
        const payloadLen = 3 + n             // status byte + "en" + text
        const msgLen = 4 + payloadLen        // hdr + typeLen + payloadLen + type
        const total = 2 + msgLen + 1         // TLV tag + len + msg + terminator
        const padded = (total + 3) & ~3
        const b = pins.createBuffer(padded)
        let i = 0
        b[i++] = 0x03          // NDEF TLV
        b[i++] = msgLen
        b[i++] = 0xD1          // MB ME SR, TNF = well known
        b[i++] = 0x01          // type length
        b[i++] = payloadLen
        b[i++] = 0x54          // "T"
        b[i++] = 0x02          // UTF-8, language code length 2
        b[i++] = 0x65          // "e"
        b[i++] = 0x6E          // "n"
        for (let k = 0; k < n; k++) b[i++] = text.charCodeAt(k) & 0xFF
        b[i++] = 0xFE          // terminator TLV
        // write 4 bytes per page starting at page 4
        for (let p = 0; p < padded / 4; p++) {
            const d = pins.createBuffer(6)
            d[0] = UL_WRITE
            d[1] = 4 + p
            d.write(2, b.slice(p * 4, 4))
            if (exchange(d, 0) == null) return false
        }
        return true
    }

    function findNdefTlv(mem: Buffer, len: number): number {
        let i = 0
        while (i < len) {
            const t = mem[i]
            if (t == 0x00) { i++; continue }            // NULL TLV
            if (t == 0x03) return i                      // NDEF message TLV
            if (t == 0xFE) return -1                     // terminator
            if (i + 1 >= len) return -1
            // lock / memory control / proprietary TLVs: skip by length
            const l = mem[i + 1]
            if (l == 0xFF) {
                if (i + 3 >= len) return -1
                i += 4 + ((mem[i + 2] << 8) | mem[i + 3])
            } else {
                i += 2 + l
            }
        }
        return -1
    }

    function parseTextRecord(mem: Buffer, start: number, end: number): string {
        let i = start
        while (i < end) {
            const hdr = mem[i++]
            const sr = (hdr & 0x10) != 0
            const il = (hdr & 0x08) != 0
            const tnf = hdr & 0x07
            const typeLen = mem[i++]
            let payloadLen = 0
            if (sr) {
                payloadLen = mem[i++]
            } else {
                payloadLen = (mem[i] << 24) | (mem[i + 1] << 16) | (mem[i + 2] << 8) | mem[i + 3]
                i += 4
            }
            const idLen = il ? mem[i++] : 0
            const typeStart = i
            i += typeLen + idLen
            const payloadStart = i
            i += payloadLen
            if (tnf == 0x01 && typeLen == 1 && mem[typeStart] == 0x54 && payloadLen > 0) {
                const langLen = mem[payloadStart] & 0x3F
                return bufToText(mem, payloadStart + 1 + langLen, Math.min(end, payloadStart + payloadLen))
            }
            if ((hdr & 0x40) != 0) break // ME: last record
        }
        return ""
    }

    // ---------------------------------------------------------------
    // Advanced
    // ---------------------------------------------------------------

    /**
     * Read a raw 16-byte MIFARE Classic block. Null if it fails.
     */
    //% block="read raw NFC block $blk"
    //% blockId=pn532_read_block group="Advanced" weight=100 advanced=true
    export function readBlock(blk: number): Buffer {
        if (!safeClassicBlock(blk)) return null
        if (!detect() || !isClassic()) return null
        if (!authBlock(blk)) return null
        return readPages(blk)
    }

    /**
     * Write a raw 16-byte buffer to a MIFARE Classic block.
     * Block 0 and sector trailers are refused.
     */
    //% block="write raw $data to NFC block $blk"
    //% blockId=pn532_write_block group="Advanced" weight=90 advanced=true
    export function writeBlock(blk: number, data: Buffer): boolean {
        if (!safeClassicBlock(blk) || !data) return false
        if (!detect() || !isClassic()) return false
        if (!authBlock(blk)) return false
        const d = pins.createBuffer(18)
        d[0] = MF_WRITE
        d[1] = blk
        d.write(2, data.slice(0, Math.min(16, data.length)))
        return exchange(d, 0) != null
    }

    /**
     * Set the MIFARE Classic key A as 12 hex characters. Default is FFFFFFFFFFFF.
     */
    //% block="set NFC key A $key"
    //% blockId=pn532_set_key group="Advanced" weight=80 advanced=true
    //% key.defl="FFFFFFFFFFFF"
    export function setKey(key: string): void {
        if (key.length != 12) return
        const k = pins.createBuffer(6)
        for (let i = 0; i < 6; i++) {
            const hi = hexVal(key.charAt(i * 2))
            const lo = hexVal(key.charAt(i * 2 + 1))
            if (hi < 0 || lo < 0) return
            k[i] = (hi << 4) | lo
        }
        authKey = k
    }

    /**
     * How often "on NFC card detected" checks for a card, in ms.
     */
    //% block="set NFC poll interval $ms ms"
    //% blockId=pn532_poll group="Advanced" weight=70 advanced=true
    //% ms.min=50 ms.max=2000 ms.defl=200
    export function setPollInterval(ms: number): void {
        pollMs = Math.max(50, ms)
    }
}
