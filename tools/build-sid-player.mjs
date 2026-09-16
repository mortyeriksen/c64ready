// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// tools/build-sid-player.mjs — assemble the C64-side SID player and embed it as
// src/media/sid-player-blob.js.
//
// A .sid becomes one ordinary .prg: a BASIC stub, a copier, this player, its
// parameter block and the tune's own bytes. The player is a fixed build — the
// same bytes for every tune — because everything tune-specific lives in the
// parameter block the host fills in. That is what lets the player be a real
// program with a screen rather than a stub generated per file.
//
// Rebuild: node tools/build-sid-player.mjs
//
// Design: investigation/SID-PLAYER-DESIGN.md

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble, screenCodes } from './asm6502.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/media/sid-player-blob.js');

const PRG_BASE = 0x0801;       // where a BASIC program loads
const SYS_TARGET = 2061;       // $080D — the classic address after a 12-byte stub
const PLAYER_ORIGIN = 0xC000;  // 4K of free RAM no PSID tune wants
const PARAM_SIZE = 114;

// `10 SYS 2061`, twelve bytes, so the copier always lands on $080D.
const BASIC_STUB = [
  0x0C, 0x08,              // link to the next line
  0x0A, 0x00,              // line number 10
  0x9E,                    // SYS
  ...[...String(SYS_TARGET)].map(c => c.charCodeAt(0)),
  0x00,                    // end of line
  0x00, 0x00,              // end of program
];

// A row of the screen, and of colour memory, by row number.
const rowTable = (base, part) => Array.from({ length: 25 },
  (_, row) => `${part}(${base}+40*${row})`).join(', ');

// Text that the player prints. Kept here rather than in the parameter block
// because it never changes with the tune.
const BAR = ' C64 READY.  SID PLAYER'.padEnd(40, ' ');
const ROW7 = '  SONG   /        :      ----  ----     ';
const KEYS1 = '1-9 0 SONG   +/- STEP   SPC PAUSE';
const KEYS_SAFE = 'F1 VOICES    F7 RESTART';
const KEYS_VOICES = 'F1 SAFE      F7 RESTART';

const source = `
; ── C64 READY SID player ─────────────────────────────────────────────────────
; Assembled for $C000 and copied there before anything else moves, so the tune's
; own load address is free to be almost anywhere below it.

        .org $${PLAYER_ORIGIN.toString(16)}

SCREEN  = $0400
COLOR   = $d800
SID     = $d400
CIA1    = $dc00
GETIN   = $ffe4
SCNKEY  = $ff9f             ; the KERNAL's keyboard scan, on its own
KERNAL_RTI = $ea81          ; the tail that pulls Y, X, A and returns
RAM_UNDER_IO = $34          ; LORAM=0, HIRAM=0 — RAM at $A000, $D000 and $E000
NORMAL_BANK  = $37

; Player variables live in their own page. Zero page belongs to the driver:
; plenty of them use all of it, and the copy below is the only time this program
; touches it — before any driver code has run.
VARS    = $cf00
curSong = VARS+0
frames  = VARS+1
secs    = VARS+2
mins    = VARS+3
tick    = VARS+4
slow    = VARS+5
slower  = VARS+23
view    = VARS+6            ; 0 = safe, 1 = voices
paused  = VARS+7
pages   = VARS+8
tmp     = VARS+9
tmp2    = VARS+10
tmp3    = VARS+11
tmp4    = VARS+12
selfdrv = VARS+13           ; the tune drives itself; there is no play to call
rowsN   = VARS+14
scopeTop = VARS+16
scPrev  = VARS+17           ; the previous column's row, so steps can be joined
scThis  = VARS+18
scFrom  = VARS+19
scTo    = VARS+20
scRow   = VARS+21
scCol   = VARS+22
heights = VARS+24           ; eight levels → bar heights, per view
shadow  = VARS+64           ; the 25 SID registers as the driver last wrote them
scope   = VARS+112          ; one oscilloscope sample per column

; Parameter block, filled in by the host (see src/media/sid.js).
P_LOAD  = 0
P_LEN   = 2
P_INIT  = 4
P_PLAY  = 6
P_SONGS = 8
P_START = 9
P_SPEED = 10
P_FLAGS = 14
P_CIA   = 16
P_TITLE = 18
P_AUTHOR = 50
P_RELEASED = 82

entry:
        sei
        cld
        lda #NORMAL_BANK
        sta $01
        lda #6                  ; blue border, black screen
        sta $d020
        lda #0
        sta $d021
        sta paused
        sta slow
        sta slower
        sta frames
        sta secs
        sta mins
        sta tick
        jsr copyPayload
        jsr patchTrampolines
        jsr clearScreen
        jsr drawStatic
        lda params+P_FLAGS      ; bit 0 says which view this tune opens in
        and #1
        sta view
        jsr drawView
        lda params+P_START
        sta curSong
        jsr startSong
        cli

; The main loop draws. The interrupt only plays, so the cycles at the top of a
; frame stay where a raster-synced tune expects to find them.
main:
        jsr readKey
        lda selfdrv
        beq mainWait
        jsr waitRaster          ; nothing sets the tick, so take it from the beam
        jsr advanceClock
        jmp mainDraw
mainWait:
        lda tick
        beq main
; Fifty redraws a second is faster than anything here changes usefully, and on a
; voice that arpeggiates it reads as flicker rather than as a trace. The scope
; redraws at 12 Hz and the text at 6, which is slow enough to follow and still
; quick enough to feel live.
mainDraw:
        lda #0
        sta tick
        inc slow
        lda slow
        cmp #4
        bcc main
        lda #0
        sta slow
        jsr sampleScope
        jsr drawScope
        inc slower
        lda slower
        cmp #2
        bcc main
        lda #0
        sta slower
        jsr drawText
        jmp main

waitRaster:
        lda $d012
        bne waitRaster
wr2:    lda $d012
        beq wr2
        rts

advanceClock:
        inc frames
        lda frames
        cmp #50
        bcc acDone
        lda #0
        sta frames
        inc secs
        lda secs
        cmp #60
        bcc acDone
        lda #0
        sta secs
        inc mins
acDone: rts

; ── the tune's bytes, moved to where it expects them ─────────────────────────
; Whole pages, and away from the overlap: descending when the destination is
; above the staged copy, ascending when it is below. The host has already made
; sure the rounded-up length still clears the player.
copyPayload:
        lda params+P_LEN+1
        sta pages
        lda params+P_LEN
        beq cpRounded
        inc pages
cpRounded:
        lda pages
        bne cpGo
        rts
cpGo:
        lda params+P_LOAD+1
        cmp #>STAGE
        bcc cpAsc
        bne cpDesc
        lda params+P_LOAD
        cmp #<STAGE
        bcc cpAsc
cpDesc:
        lda #<STAGE
        sta $fb
        lda #>STAGE
        clc
        adc pages
        sec
        sbc #1
        sta $fc
        lda params+P_LOAD
        sta $fd
        lda params+P_LOAD+1
        clc
        adc pages
        sec
        sbc #1
        sta $fe
        ldx pages
cpDPage:
        ldy #$ff
cpDByte:
        lda ($fb),y
        sta ($fd),y
        dey
        cpy #$ff
        bne cpDByte
        dec $fc
        dec $fe
        dex
        bne cpDPage
        rts
cpAsc:
        lda #<STAGE
        sta $fb
        lda #>STAGE
        sta $fc
        lda params+P_LOAD
        sta $fd
        lda params+P_LOAD+1
        sta $fe
        ldx pages
cpAPage:
        ldy #0
cpAByte:
        lda ($fb),y
        sta ($fd),y
        iny
        bne cpAByte
        inc $fc
        inc $fe
        dex
        bne cpAPage
        rts

patchTrampolines:
        lda params+P_INIT
        sta initJmp+1
        lda params+P_INIT+1
        sta initJmp+2
        lda params+P_PLAY
        sta playJmp+1
        lda params+P_PLAY+1
        sta playJmp+2
        lda params+P_PLAY
        ora params+P_PLAY+1
        beq ptSelf
        lda #0
        sta selfdrv
        rts
ptSelf: lda #1
        sta selfdrv
        rts

initJmp:
        jmp $0000
playJmp:
        jmp $0000

; ── the interrupt ────────────────────────────────────────────────────────────
irq:
        asl $d019               ; acknowledge whichever source fired
        lda CIA1+13
        lda paused
        bne irqTick
        lda view
        beq irqPlain
        ; Voices view: let the driver write into the RAM under $D400, read all
        ; 25 registers back, then put them on the real chip. This is the only
        ; way to see voices 1 and 2 — and it collapses a digi driver's many
        ; writes per frame into one, which is why F1 exists.
        lda #RAM_UNDER_IO
        sta $01
        jsr playJmp
        jsr grabShadow
        lda #NORMAL_BANK
        sta $01
        jsr pushShadow
        jmp irqTick
irqPlain:
        jsr playJmp
irqTick:
        jsr advanceClock
        lda #1
        sta tick
        ; Only the keyboard scan, not the whole KERNAL handler: that one also
        ; blinks a cursor over whatever cell BASIC last left it on, and there is
        ; no BASIC here to own it.
        jsr SCNKEY
        jmp KERNAL_RTI

; Read back everything the driver wrote. Only correct while I/O is banked out,
; which is the whole point: with it banked in these addresses are the chip, and
; the chip cannot be read.
grabShadow:
        ldx #0
gsLoop: lda SID,x
        sta shadow,x
        inx
        cpx #25
        bne gsLoop
        rts

pushShadow:
        ldx #0
psLoop: lda shadow,x
        sta SID,x
        inx
        cpx #25
        bne psLoop
        rts

; ── songs ────────────────────────────────────────────────────────────────────
songSpeed:                      ; A = 1 when this song wants the CIA timer
        lda curSong
        sec
        sbc #1
        pha
        lsr
        lsr
        lsr
        tay
        pla
        and #7
        tax
        lda params+P_SPEED,y
ssShift:
        cpx #0
        beq ssDone
        lsr
        dex
        jmp ssShift
ssDone: and #1
        rts

setupIrq:
        lda selfdrv
        beq siInstall
        rts                     ; the tune installs its own; leave it alone
siInstall:
        sei
        lda #$7f
        sta CIA1+13
        lda CIA1+13
        jsr songSpeed
        beq siRaster
        lda #0
        sta $d01a
        lda params+P_CIA
        sta CIA1+4
        lda params+P_CIA+1
        sta CIA1+5
        lda #$81
        sta CIA1+13
        lda #$11
        sta CIA1+14
        jmp siVector
siRaster:
        lda #$01
        sta $d01a
        lda #$00
        sta $d012
        lda $d011
        and #$7f
        sta $d011
        asl $d019
siVector:
        lda #<irq
        sta $0314
        lda #>irq
        sta $0315
        cli
        rts

silence:
        php
        sei
        lda #0
        sta SID+4
        sta SID+11
        sta SID+18
        sta SID+24
        lda #RAM_UNDER_IO       ; and the shadow the driver writes into
        sta $01
        lda #0
        ldx #24
slRam:  sta SID,x
        dex
        bpl slRam
        lda #NORMAL_BANK
        sta $01
        lda #0
        ldx #24
slShadow:
        sta shadow,x
        dex
        bpl slShadow
        plp
        rts

startSong:
        sei
        jsr silence
        lda #0
        sta frames
        sta secs
        sta mins
        lda view
        beq ssPlain
        ; In the voices view init writes into the shadow too. A driver that sets
        ; the volume once, in init, and never again — which is most of them —
        ; would otherwise have it pushed back as zero on the very next frame.
        lda #RAM_UNDER_IO
        sta $01
        lda curSong
        sec
        sbc #1
        jsr initJmp
        jsr grabShadow
        lda #NORMAL_BANK
        sta $01
        jsr pushShadow
        jmp ssAfter
ssPlain:
        lda curSong
        sec
        sbc #1
        jsr initJmp
ssAfter:
        ; A driver's init may restore the KERNAL vector from its own stop path,
        ; which would silence every song change after the first.
        jsr setupIrq
        cli
        rts

; ── keys ─────────────────────────────────────────────────────────────────────
readKey:
        jsr GETIN
        bne rkHave
        rts
rkHave:
        cmp #$20
        bne rk1
        jmp keyPause
rk1:    cmp #$85                ; F1
        bne rk2
        jmp keyView
rk2:    cmp #$88                ; F7
        bne rk3
        jmp keyRestart
rk3:    cmp #$2b                ; +
        bne rk4
        lda curSong
        clc
        adc #1
        jmp keySong
rk4:    cmp #$2d                ; -
        bne rk5
        lda curSong
        sec
        sbc #1
        jmp keySong
rk5:    cmp #$30                ; 0 selects the tenth song
        bne rk6
        lda #10
        jmp keySong
rk6:    cmp #$31
        bcc rkOut
        cmp #$3a
        bcs rkOut
        sec
        sbc #$30
        jmp keySong
rkOut:  rts

keySong:
        sta tmp
        lda tmp
        beq ksLast              ; stepping below the first wraps to the last
        lda params+P_SONGS
        cmp tmp
        bcs ksSet
        lda #1                  ; and past the last wraps to the first
        sta tmp
        jmp ksSet
ksLast:
        lda params+P_SONGS
        sta tmp
ksSet:
        lda tmp
        sta curSong
keyRestart:
        sei
        jsr startSong
        cli
        jmp drawText

keyPause:
        lda paused
        eor #1
        sta paused
        beq kpDone
        jsr silence
kpDone: rts

keyView:
        lda view
        eor #1
        sta view
        jsr drawView
        ; The shadow is only ever right if init ran under the same banking, so a
        ; switch starts the song again rather than pushing a half-empty shadow
        ; over what the driver set once and will not set twice.
        sei
        jsr startSong
        cli
        jmp drawText

; ── drawing ──────────────────────────────────────────────────────────────────
clearScreen:
        ldx #0
csLoop: lda #$20
        sta SCREEN,x
        sta SCREEN+250,x
        sta SCREEN+500,x
        sta SCREEN+750,x
        lda #12
        sta COLOR,x
        sta COLOR+250,x
        sta COLOR+500,x
        sta COLOR+750,x
        inx
        cpx #250
        bne csLoop
        rts

; Walk a table of {count, source, destination} records. Both tables end with a
; zero count, and copyN leaves Y alone so the walk keeps its place.
drawStatic:
        ldy #0
dsWalk: lda staticTable,y
        beq dsColours
        sta tmp
        iny
        lda staticTable,y
        sta cnSrc+1
        iny
        lda staticTable,y
        sta cnSrc+2
        iny
        lda staticTable,y
        sta cnDst+1
        iny
        lda staticTable,y
        sta cnDst+2
        iny
        jsr copyN
        jmp dsWalk
dsColours:
        ldy #0
dcWalk: lda colourTable,y
        beq dsChip
        sta tmp
        iny
        lda colourTable,y
        sta tmp2
        iny
        lda colourTable,y
        sta fnDst+1
        iny
        lda colourTable,y
        sta fnDst+2
        iny
        lda tmp2
        jsr fillN
        jmp dcWalk
; The chip and the clock come out of the header and never change while a tune
; plays, so they are written once here. An NTSC tune on this PAL machine runs
; about 17% slow; saying so is better than leaving it a mystery.
dsChip:
        lda params+P_FLAGS
        lsr
        lsr
        lsr
        lsr
        and #3
        asl
        asl
        tax
        ldy #0
dsChipLoop:
        lda chipNames,x
        sta SCREEN+40*7+25,y
        inx
        iny
        cpy #4
        bne dsChipLoop
        lda params+P_FLAGS
        lsr
        lsr
        and #3
        sta tmp2
        asl
        asl
        tax
        ldy #0
dsClockLoop:
        lda clockNames,x
        sta SCREEN+40*7+31,y
        lda #3
        sta COLOR+40*7+31,y
        inx
        iny
        cpy #4
        bne dsClockLoop
        lda tmp2
        cmp #2                  ; NTSC
        bne dsDone
        ldy #0
dsNtsc: lda #10                 ; light red, because it will not sound right
        sta COLOR+40*7+31,y
        iny
        cpy #4
        bne dsNtsc
dsDone: rts

copyN:  ldx #0
cnLoop:
cnSrc:  lda $ffff,x
cnDst:  sta $ffff,x
        inx
        cpx tmp
        bne cnLoop
        rts

fillN:  ldx #0
fnLoop:
fnDst:  sta $ffff,x
        inx
        cpx tmp
        bne fnLoop
        rts

; A row of horizontal line characters, columns 2 to 37.
rule:                           ; X = row
        lda rowLo,x
        clc
        adc #2
        sta ruleSt+1
        lda rowHi,x
        adc #0
        sta ruleSt+2
        ldx #0
        lda #$40
ruleLoop:
ruleSt: sta $ffff,x
        inx
        cpx #36
        bne ruleLoop
        rts

; Everything between the rules belongs to one view or the other, so a switch
; clears rows 9 to 20 and draws that view alone.
drawView:
        ldx #0
dvClear:
        lda #$20
        sta SCREEN+40*9,x
        sta SCREEN+40*9+240,x
        lda #12
        sta COLOR+40*9,x
        sta COLOR+40*9+240,x
        inx
        cpx #240
        bne dvClear
        lda view
        bne dvVoices
        ; Safe view: the voice 3 oscilloscope is the subject, and every value on
        ; screen is one a program on real hardware can actually read back.
        ldx #9
        jsr rule
        ldx #19
        jsr rule
        lda #<envLabel
        sta cnSrc+1
        lda #>envLabel
        sta cnSrc+2
        lda #<(SCREEN+40*17+2)
        sta cnDst+1
        lda #>(SCREEN+40*17+2)
        sta cnDst+2
        lda #5
        sta tmp
        jsr copyN
        lda #10
        sta scopeTop
        lda #6
        sta rowsN
        ldx #0
dvHeight6:
        lda heights6,x
        sta heights,x
        inx
        cpx #8
        bne dvHeight6
        lda #<keysSafe
        sta cnSrc+1
        lda #>keysSafe
        sta cnSrc+2
        jmp dvKeys
dvVoices:
        ldx #9
        jsr rule
        ldx #15
        jsr rule
        lda #<voiceLabels
        sta cnSrc+1
        lda #>voiceLabels
        sta cnSrc+2
        lda #<(SCREEN+40*10+2)
        sta cnDst+1
        lda #>(SCREEN+40*10+2)
        sta cnDst+2
        lda #1
        sta tmp
        jsr copyN
        lda #<(voiceLabels+1)
        sta cnSrc+1
        lda #<(SCREEN+40*11+2)
        sta cnDst+1
        lda #>(SCREEN+40*11+2)
        sta cnDst+2
        jsr copyN
        lda #<(voiceLabels+2)
        sta cnSrc+1
        lda #<(SCREEN+40*12+2)
        sta cnDst+1
        lda #>(SCREEN+40*12+2)
        sta cnDst+2
        jsr copyN
        lda #<filterLabel
        sta cnSrc+1
        lda #>filterLabel
        sta cnSrc+2
        lda #<(SCREEN+40*14+2)
        sta cnDst+1
        lda #>(SCREEN+40*14+2)
        sta cnDst+2
        lda #36
        sta tmp
        jsr copyN
        lda #16
        sta scopeTop
        lda #5
        sta rowsN
        ldx #0
dvHeight5:
        lda heights5,x
        sta heights,x
        inx
        cpx #8
        bne dvHeight5
        lda #<keysVoices
        sta cnSrc+1
        lda #>keysVoices
        sta cnSrc+2
dvKeys:
        lda #<(SCREEN+40*22+2)
        sta cnDst+1
        lda #>(SCREEN+40*22+2)
        sta cnDst+2
        lda #23
        sta tmp
        jsr copyN
        jsr colourView
        rts

; Colour follows the view: the scope cyan, bars green, values yellow.
colourView:
        ldy #0
cvWalk: lda view
        beq cvSafe
        lda voiceColours,y
        jmp cvHave
cvSafe: lda safeColours,y
cvHave: beq cvDone
        sta tmp
        iny
        jsr cvFetch
        sta tmp2
        iny
        jsr cvFetch
        sta fnDst+1
        iny
        jsr cvFetch
        sta fnDst+2
        iny
        lda tmp2
        jsr fillN
        jmp cvWalk
cvDone: rts
cvFetch:
        lda view
        beq cvFetchSafe
        lda voiceColours,y
        rts
cvFetchSafe:
        lda safeColours,y
        rts

; ── the oscilloscope ─────────────────────────────────────────────────────────
; Oscillator 3 is readable on real hardware, so this is honest in both views.
sampleScope:
        ; Trigger first, the way a scope does: wait for the oscillator to fall
        ; below a floor and then rise past a ceiling, so every frame starts at
        ; the same point in the wave and a steady note stands still. Untriggered,
        ; a third of the trace redraws every frame and the whole thing churns.
        ; Both waits give up after a while, so silence and notes too low to come
        ; round inside a frame still draw something rather than nothing.
        ldy #0
ssLow:  lda SID+27
        cmp #$50
        bcc ssArmed
        dey
        bne ssLow
        jmp ssStart
ssArmed:
        ldy #0
ssRise: lda SID+27
        cmp #$b0
        bcs ssStart
        dey
        bne ssRise
ssStart:
        ldx #0
ssSample:
        lda SID+27
        lsr
        lsr
        lsr
        lsr
        lsr
        tay
        lda heights,y
        sta scope,x
        ; ~260 cycles a sample. The 36 columns span about 9,400 cycles — two
        ; periods of a lead, two thirds of a bass note — which leaves room in the
        ; frame for the trigger above. Standing still matters more than fitting a
        ; whole period in: a jittering full period reads as noise.
        ldy #45
ssWait: dey
        bne ssWait
        inx
        cpx #36
        bne ssSample
        ; A trace that never moves is not a signal: voice 3 is idle and its
        ; oscillator has frozen at whatever it last held, which can be anywhere
        ; — at the top of the scope it reads as the trace having vanished into
        ; the rule above. Put a flat line on the baseline instead, which is what
        ; a scope with nothing on its input shows.
        ldx #1
        lda scope
ssFlat: cmp scope,x
        bne ssVaried
        inx
        cpx #36
        bne ssFlat
        lda rowsN
        lsr
        ldx #0
ssCentre:
        sta scope,x
        inx
        cpx #36
        bne ssCentre
ssVaried:
        rts

; A trace, not a level meter: one dash at each sample's own row, and vertical
; bars filling the gap to the sample before it, so an edge reads as an edge.
scopeRowAt:                     ; A = row within the scope → patch both writers
        clc
        adc scopeTop
        tax
        lda rowLo,x
        clc
        adc #2
        sta dscSt+1
        sta sclSt+1
        lda rowHi,x
        adc #0
        sta dscSt+2
        sta sclSt+2
        rts

scopeClear:
        ldy #0
sclRow: sty scRow
        tya
        jsr scopeRowAt
        ldx #0
        lda #$20
sclCol:
sclSt:  sta $ffff,x
        inx
        cpx #36
        bne sclCol
        ldy scRow
        iny
        cpy rowsN
        bne sclRow
        rts

drawScope:
        jsr scopeClear
        ldx #0
        lda scope
        sta scPrev
dscCol: lda scope,x
        sta scThis
        ; the span this column covers: from the previous row to this one
        lda scPrev
        cmp scThis
        bcs dscDown
        sta scFrom
        lda scThis
        sta scTo
        jmp dscSpan
dscDown:
        lda scThis
        sta scFrom
        lda scPrev
        sta scTo
dscSpan:
        ldy scFrom
dscCell:
        sty scRow
        stx scCol
        tya
        jsr scopeRowAt
        ldx scCol
        ldy scRow
        cpy scThis
        beq dscDash
        lda #$5d                ; a vertical bar joins the step
        jmp dscPut
dscDash:
        lda #$40                ; and a dash marks the sample itself
dscPut:
dscSt:  sta $ffff,x
        ldy scRow
        cpy scTo
        beq dscNext
        iny
        jmp dscCell
dscNext:
        lda scThis
        sta scPrev
        inx
        cpx #36
        bne dscCol
        rts

; ── the text that changes ────────────────────────────────────────────────────
drawText:
        lda curSong
        ldx #<(SCREEN+40*7+7)
        ldy #>(SCREEN+40*7+7)
        jsr putDecimal
        lda params+P_SONGS
        ldx #<(SCREEN+40*7+10)
        ldy #>(SCREEN+40*7+10)
        jsr putDecimal
        lda mins
        ldx #<(SCREEN+40*7+16)
        ldy #>(SCREEN+40*7+16)
        jsr putDecimal
        lda secs
        ldx #<(SCREEN+40*7+19)
        ldy #>(SCREEN+40*7+19)
        jsr putDecimal
        lda view
        bne dtVoices
        jmp drawEnvelope
dtVoices:
        jmp drawVoices

; A = value 0-99, X/Y = where the two digits go.
putDecimal:
        stx pdTens+1
        sty pdTens+2
        stx pdOnes+1
        sty pdOnes+2
        inc pdOnes+1
        bne pdNoCarry
        inc pdOnes+2
pdNoCarry:
        ldx #$30
pdTen:  cmp #10
        bcc pdUnits
        sec
        sbc #10
        inx
        jmp pdTen
pdUnits:
        clc
        adc #$30
pdOnes: sta $ffff
        txa
pdTens: sta $ffff
        rts

hexDigit:                       ; A = 0-15 → a screen code
        cmp #10
        bcc hdDigit
        sec
        sbc #9                  ; 10 → $01, which is the letter A
        rts
hdDigit:
        ora #$30
        rts

putHex:                         ; A = byte, X = column, row already patched
        pha
        lsr
        lsr
        lsr
        lsr
        jsr hexDigit
phHi:   sta $ffff,x
        inx
        pla
        and #$0f
        jsr hexDigit
phLo:   sta $ffff,x
        inx
        rts

drawEnvelope:
        lda SID+28              ; envelope 3, the one a program may read
        lsr
        lsr
        lsr
        lsr
        sta tmp
        ldx #0
deLoop: cpx tmp
        bcs deBlank
        lda #$a0
        jmp dePut
deBlank:
        lda #$20
dePut:  sta SCREEN+40*17+9,x
        inx
        cpx #16
        bne deLoop
        rts

drawVoices:
        lda #<(SCREEN+40*10)
        ldx #>(SCREEN+40*10)
        ldy #0
        jsr drawVoice
        lda #<(SCREEN+40*11)
        ldx #>(SCREEN+40*11)
        ldy #7
        jsr drawVoice
        lda #<(SCREEN+40*12)
        ldx #>(SCREEN+40*12)
        ldy #14
        jsr drawVoice
        jmp drawFilter

; How long a voice's bar is: where its frequency sits, by octave. The SID's
; frequency register is linear in hertz and pitch is not, so the bar counts the
; highest set bit — one cell per octave — rather than scaling the number. A
; closed gate is no bar at all.
voiceBar:
        ldy tmp4
        lda shadow+4,y
        and #1
        beq vbSilent
        ldx #15
        lda shadow+1,y
        beq vbLowByte
vbHigh: asl
        bcs vbFound
        dex
        jmp vbHigh
vbLowByte:
        ldx #7
        lda shadow,y
        beq vbSilent
vbLow:  asl
        bcs vbFound
        dex
        jmp vbLow
vbFound:
        txa
        sec
        sbc #3
        bcc vbSilent
        cmp #13
        bcc vbDone
        lda #12
vbDone: rts
vbSilent:
        lda #0
        rts

; A/X = the row's address, Y = the voice's first register in the shadow.
drawVoice:
        sty tmp4
        sta dviBar+1
        sta dviName+1
        sta dviDollar+1
        sta phHi+1
        sta phLo+1
        stx dviBar+2
        stx dviName+2
        stx dviDollar+2
        stx phHi+2
        stx phLo+2
        ; The bar is the voice's pitch while its gate is open — the envelope
        ; itself is not readable, and guessing at one would be a drawing, not a
        ; reading.
        jsr voiceBar
        sta tmp3
        ldx #4
dviBarLoop:
        txa
        sec
        sbc #4
        cmp tmp3
        bcc dviBarFill
        lda #$20
        jmp dviBarPut
dviBarFill:
        lda #$a0
dviBarPut:
dviBar: sta $ffff,x
        inx
        cpx #16
        bne dviBarLoop
        ; the waveform, named by its highest bit
        ldy tmp4
        lda shadow+4,y
        and #$f0
        ldy #0
        cmp #$10
        bcc dviNameAt
        ldy #5
        cmp #$20
        bcc dviNameAt
        ldy #10
        cmp #$40
        bcc dviNameAt
        ldy #15
        cmp #$80
        bcc dviNameAt
        ldy #20
dviNameAt:
        ldx #17
dviNameLoop:
        lda waveNames,y
dviName:
        sta $ffff,x
        iny
        inx
        cpx #22
        bne dviNameLoop
        ; frequency and the ADSR pair, as the driver wrote them
        lda #$24                ; a dollar sign
        ldx #23
dviDollar:
        sta $ffff,x
        ldy tmp4
        lda shadow+1,y
        ldx #24
        jsr putHex
        ldy tmp4
        lda shadow,y
        jsr putHex
        ldy tmp4
        lda shadow+5,y
        ldx #29
        jsr putHex
        ldy tmp4
        lda shadow+6,y
        jsr putHex
        rts

drawFilter:
        lda #<(SCREEN+40*14)
        sta phHi+1
        sta phLo+1
        lda #>(SCREEN+40*14)
        sta phHi+2
        sta phLo+2
        ; filter mode, from the three bits above the volume
        lda shadow+24
        ldy #0
        and #$70
        beq dfMode
        ldy #2
        cmp #$20
        bcc dfMode
        ldy #4
        cmp #$40
        bcc dfMode
        ldy #6
dfMode: ldx #0
dfModeLoop:
        lda filterModes,y
        sta SCREEN+40*14+6,x
        iny
        inx
        cpx #2
        bne dfModeLoop
        ; cutoff, from its high byte
        lda shadow+22
        lsr
        lsr
        lsr
        lsr
        lsr
        tax
        lda cutTable,x
        sta tmp
        ldx #0
dfCut:  cpx tmp
        bcs dfCutBlank
        lda #$a0
        jmp dfCutPut
dfCutBlank:
        lda #$20
dfCutPut:
        sta SCREEN+40*14+15,x
        inx
        cpx #10
        bne dfCut
        ; resonance and volume, one nibble each
        lda shadow+23
        lsr
        lsr
        lsr
        lsr
        jsr hexDigit
        sta SCREEN+40*14+31
        lda shadow+24
        and #$0f
        jsr hexDigit
        sta SCREEN+40*14+38
        lda #7
        sta COLOR+40*14+31
        sta COLOR+40*14+38
        rts

; ── data ─────────────────────────────────────────────────────────────────────
rowLo:  .byte ${rowTable('SCREEN', '<')}
rowHi:  .byte ${rowTable('SCREEN', '>')}

barText:    .byte ${screenCodes(BAR).map(code => code | 0x80).join(', ')}
row7Text:   .scr "${ROW7}"
keys1Text:  .scr "${KEYS1}"
keysSafe:   .scr "${KEYS_SAFE}"
keysVoices: .scr "${KEYS_VOICES}"
envLabel:   .scr "ENV 3"
voiceLabels: .scr "123"
filterLabel: .scr "FLT      CUT             RES    VOL "
waveNames:  .scr "     TRI  SAW  PULSENOISE"
chipNames:  .scr "----6581" 
            .scr "8580ANY "
clockNames: .scr "----PAL "
            .scr "NTSCANY "
filterModes: .scr "--LPBPHP"

; Eight oscillator levels mapped onto the rows each view has room for, counted
; from the top: a quiet sample sits low, a loud one high.
heights6:   .byte 5, 4, 4, 3, 2, 1, 1, 0
heights5:   .byte 4, 4, 3, 2, 2, 1, 0, 0
cutTable:   .byte 0, 1, 2, 4, 5, 6, 8, 10

; {count, source, destination}, a zero count ends it.
staticTable:
        .byte 40, <barText, >barText, <(SCREEN+40*1), >(SCREEN+40*1)
        .byte 40, <row7Text, >row7Text, <(SCREEN+40*7), >(SCREEN+40*7)
        .byte 32, <(params+P_TITLE), >(params+P_TITLE), <(SCREEN+40*3+2), >(SCREEN+40*3+2)
        .byte 32, <(params+P_AUTHOR), >(params+P_AUTHOR), <(SCREEN+40*4+2), >(SCREEN+40*4+2)
        .byte 32, <(params+P_RELEASED), >(params+P_RELEASED), <(SCREEN+40*5+2), >(SCREEN+40*5+2)
        .byte 33, <keys1Text, >keys1Text, <(SCREEN+40*21+2), >(SCREEN+40*21+2)
        .byte 0

; {count, colour, destination}, a zero count ends it.
colourTable:
        .byte 40, 3, <(COLOR+40*1), >(COLOR+40*1)
        .byte 32, 1, <(COLOR+40*3+2), >(COLOR+40*3+2)
        .byte 32, 15, <(COLOR+40*4+2), >(COLOR+40*4+2)
        .byte 32, 12, <(COLOR+40*5+2), >(COLOR+40*5+2)
        .byte 5, 7, <(COLOR+40*7+7), >(COLOR+40*7+7)
        .byte 5, 7, <(COLOR+40*7+16), >(COLOR+40*7+16)
        .byte 4, 3, <(COLOR+40*7+25), >(COLOR+40*7+25)
        .byte 0

safeColours:
        .byte 36, 3, <(COLOR+40*10+2), >(COLOR+40*10+2)
        .byte 36, 3, <(COLOR+40*11+2), >(COLOR+40*11+2)
        .byte 36, 3, <(COLOR+40*12+2), >(COLOR+40*12+2)
        .byte 36, 3, <(COLOR+40*13+2), >(COLOR+40*13+2)
        .byte 36, 3, <(COLOR+40*14+2), >(COLOR+40*14+2)
        .byte 36, 3, <(COLOR+40*15+2), >(COLOR+40*15+2)
        .byte 16, 5, <(COLOR+40*17+9), >(COLOR+40*17+9)
        .byte 0

voiceColours:
        .byte 12, 5, <(COLOR+40*10+4), >(COLOR+40*10+4)
        .byte 12, 5, <(COLOR+40*11+4), >(COLOR+40*11+4)
        .byte 12, 5, <(COLOR+40*12+4), >(COLOR+40*12+4)
        .byte 10, 3, <(COLOR+40*10+17), >(COLOR+40*10+17)
        .byte 10, 3, <(COLOR+40*11+17), >(COLOR+40*11+17)
        .byte 10, 3, <(COLOR+40*12+17), >(COLOR+40*12+17)
        .byte 10, 5, <(COLOR+40*14+15), >(COLOR+40*14+15)
        .byte 36, 3, <(COLOR+40*16+2), >(COLOR+40*16+2)
        .byte 36, 3, <(COLOR+40*17+2), >(COLOR+40*17+2)
        .byte 36, 3, <(COLOR+40*18+2), >(COLOR+40*18+2)
        .byte 36, 3, <(COLOR+40*19+2), >(COLOR+40*19+2)
        .byte 36, 3, <(COLOR+40*20+2), >(COLOR+40*20+2)
        .byte 0

params: .fill ${PARAM_SIZE}
playerEnd:
`;

// The player needs the address its tune was staged at, and that address depends
// on how long the player and the copier turn out to be. Assemble, measure,
// assemble again: the constant is only ever used as an immediate, so the second
// pass is the same length as the first.
function build() {
  let stage = 0;
  let player = null, copier = null;
  for (let round = 0; round < 4; round++) {
    player = assemble(source, { STAGE: stage });
    const blobAt = PRG_BASE + BASIC_STUB.length;
    copier = assemble(`
        .org $${(PRG_BASE + BASIC_STUB.length).toString(16)}
; Move the player to its own address and go. Nothing else happens first, so the
; player is out of the way before it starts moving the tune.
        sei
        lda #<blob
        sta $fb
        lda #>blob
        sta $fc
        lda #0
        sta $fd
        lda #$c0
        sta $fe
        ldx #${Math.ceil(player.bytes.length / 256)}
copyPage:
        ldy #0
copyByte:
        lda ($fb),y
        sta ($fd),y
        iny
        bne copyByte
        inc $fc
        inc $fe
        dex
        bne copyPage
        jmp $c000
blob:
`, {});
    void blobAt;
    const next = PRG_BASE + BASIC_STUB.length + copier.bytes.length + player.bytes.length;
    if (next === stage) break;
    stage = next;
  }
  return { player, copier, stage };
}

const { player, copier, stage } = build();
const front = Uint8Array.from([
  PRG_BASE & 0xFF, PRG_BASE >> 8,
  ...BASIC_STUB, ...copier.bytes, ...player.bytes,
]);
const paramAt = front.length - PARAM_SIZE;
const playerEnd = player.symbols.playerEnd;

if (playerEnd > 0xCF00) throw new Error(`the player runs into its own variables at $${playerEnd.toString(16)}`);
if (stage !== PRG_BASE + BASIC_STUB.length + copier.bytes.length + player.bytes.length) throw new Error('the staged address never settled');

const js = `// SPDX-License-Identifier: GPL-3.0-or-later
// src/media/sid-player-blob.js — the C64-side SID player, assembled.
//
// GENERATED FILE — do not edit by hand. Rebuild: node tools/build-sid-player.mjs
// Source: tools/build-sid-player.mjs (the program) + tools/asm6502.mjs (the
// assembler). Design: investigation/SID-PLAYER-DESIGN.md
//
// PLAYER is everything in the .prg ahead of the tune: the two-byte load address,
// a BASIC stub, the copier that moves the player to $${PLAYER_ORIGIN.toString(16).toUpperCase()}, and the player
// itself ending in its parameter block. A .sid becomes a .prg by filling in that
// block and appending the tune's own bytes.

/** Where the parameter block starts inside PLAYER. */
export const PARAM_AT = ${paramAt};
/** How long the parameter block is. */
export const PARAM_SIZE = ${PARAM_SIZE};
/** The address the tune's bytes sit at before the player moves them. */
export const PAYLOAD_STAGE = 0x${stage.toString(16).toUpperCase()};
/** The player's own address; a tune may not load over it. */
export const PLAYER_ORIGIN = 0x${PLAYER_ORIGIN.toString(16).toUpperCase()};
/** The top of the player's variables — the real ceiling for a tune. */
export const PLAYER_TOP = 0xD000;
/** Where the .prg loads. */
export const PRG_BASE = 0x${PRG_BASE.toString(16).toUpperCase()};

export const PLAYER = Uint8Array.from([
${Array.from(front).map((b, i) => (i % 16 === 0 ? '  ' : '') + b).reduce((rows, value, i) => {
  if (i % 16 === 0) rows.push([]);
  rows[rows.length - 1].push(value);
  return rows;
}, []).map(row => row.join(', ')).join(',\n')},
]);
`;
fs.writeFileSync(OUT, js);
console.log(`player   ${player.bytes.length} bytes ($C000–$${(playerEnd - 1).toString(16).toUpperCase()}, params at $${(playerEnd - PARAM_SIZE).toString(16).toUpperCase()})`);
console.log(`copier   ${copier.bytes.length} bytes`);
console.log(`front    ${front.length} bytes, tune staged at $${stage.toString(16).toUpperCase()}`);
console.log(`wrote    ${path.relative(ROOT, OUT)}`);
