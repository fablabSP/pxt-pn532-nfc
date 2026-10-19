// Step-by-step hardware test. Flash, then follow the README test plan.
nfc.init()
if (nfc.isConnected()) {
    basic.showIcon(IconNames.Yes)
    basic.showString(nfc.firmwareVersion())
} else {
    basic.showIcon(IconNames.No)
}

// Step 2: button A shows the UID of the card on the reader
input.onButtonPressed(Button.A, function () {
    const uid = nfc.readUID()
    basic.showString(uid == "" ? "-" : uid)
})

// Step 4: button B writes then reads MIFARE block 4
input.onButtonPressed(Button.B, function () {
    if (nfc.writeBlockText(4, "FabLab")) {
        basic.showString(nfc.readBlockText(4))
    } else {
        basic.showIcon(IconNames.Sad)
    }
})

// Step 5: A+B writes NDEF text to an NTAG sticker, then reads it back
input.onButtonPressed(Button.AB, function () {
    if (nfc.writeNDEFText("Hello from micro:bit")) {
        basic.showString(nfc.readNDEFText())
    } else {
        basic.showIcon(IconNames.Sad)
    }
})

// Step 3: tap event (fires once per tap)
nfc.onCardDetected(function (uid) {
    serial.writeLine("card " + uid + " " + nfc.cardType())
    music.play(music.tonePlayable(Note.C5, music.beat(BeatFraction.Sixteenth)), music.PlaybackMode.InBackground)
})
