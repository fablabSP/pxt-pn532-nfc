# PN532 NFC for micro:bit (BLE HID friendly)

MakeCode extension for a PN532 NFC/RFID module over I2C on micro:bit V2.

It depends on `core` only: no `radio`, no `bluetooth`, no `yotta` settings. That means it can sit in the same project as [bsiever/microbit-pxt-blehid](https://github.com/bsiever/microbit-pxt-blehid) without the "conflict on yotta setting" error.

## Wiring

| PN532 | micro:bit |
|---|---|
| SDA | P20 |
| SCL | P19 |
| VCC | 3V (use 5V from a breakout if it is not detected) |
| GND | GND |

Set the module switches to **I2C**: SEL0 = ON (1), SEL1 = OFF (0). Power cycle the module after changing switches.

## Blocks

**Setup**
- `init NFC (PN532 I2C)`
- `NFC module connected`
- `NFC firmware version`

**Read**
- `NFC card detected`
- `NFC card UID` (hex text, empty if no card)
- `NFC card type` ("MIFARE Classic", "NTAG", "Unknown")
- `on NFC card detected (uid)` (fires once per tap)

**Card data (MIFARE Classic, e.g. the white card and blue keyfob)**
- `read text from NFC block`
- `write text to NFC block` (16 characters max)
- Block 0 and sector trailers (3, 7, 11, ...) are refused so students cannot brick cards.

**NDEF (NTAG stickers, phone readable)**
- `read NDEF text from NFC tag`
- `write NDEF text to NFC tag` (130 characters max, ASCII)

**Advanced**
- raw block read/write, set key A, set poll interval

## Use with BLE HID

1. New project, add this extension, then add `https://github.com/bsiever/microbit-pxt-blehid`.
2. Do not add `radio`, `bluetooth`, or other NFC extensions.
3. Leave Bluetooth pairing at the default (JustWorks) in Project Settings.

```typescript
nfc.init()
keyboard.startKeyboardService()
nfc.onCardDetected(function (uid) {
    keyboard.sendString(uid + keyboard.keys(keyboard._Key.enter))
})
```

Pair the micro:bit from the computer's Bluetooth settings, then tap a card: the UID gets typed into whatever window has focus.

## Test plan (do in order, test between each step)

1. Flash `test.ts`. Tick then "PN532 v1.6" = module OK. Cross = check wiring and switches.
2. Put a card on the reader, press **A**: UID scrolls.
3. Open serial (Show data Device): each tap prints `card <uid> <type>` once and beeps.
4. MIFARE card on reader, press **B**: shows "FabLab" (written then read from block 4).
5. NTAG sticker on reader, press **A+B**: shows the text. Then tap the sticker with a phone, it should show "Hello from micro:bit".
6. Add blehid using the example above, pair, tap a card: UID is typed.

## Troubleshooting

- **Not detected:** check the I2C switches, swap SDA/SCL, try 5V power, power cycle the module.
- **Slow when no card:** this is normal at about 100 ms per check. Lower the poll rate with `set NFC poll interval`.
- **Yotta / bluetooth conflict error:** some other extension in the project brings in `radio` or sets bluetooth config. Remove it. See Project Settings and make sure pairing is JustWorks.
- **NDEF write fails:** it only works on NTAG/Ultralight stickers, not MIFARE Classic cards.

## Rules learned

- Never depend on `radio` in an extension that might be used with Bluetooth. MakeCode turns Bluetooth off for the whole project.
- Never put a `yotta` bluetooth block in an extension. Leave Bluetooth config to the Bluetooth extension.
- PN532 passive activation retries must be limited (not 0xFF) or "card detected" blocks until a card arrives.

## License

MIT
