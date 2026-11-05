<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: Achievements and high scores for C64 games, the activity of everyone playing, player profiles, the chat, and the passkey account behind them. -->

# Achievements

![How achievements work, in four steps: load a game and its file is matched to the game's set, play while each frame the set reads the C64's memory, your unlocks and best scores are saved, and they are shared as Trophy Hunters, high scores and activity. Below, where you see it: the GAME tab, the trophy HUD in Retro Vibes, toasts and attract mode.](/guide/achievements-overview.svg)

Some games have achievements: goals like clearing a level or passing a score.
Each one unlocks the moment you reach it, and your best score goes on the
game's leaderboard. The same window holds a chat for everyone signed in. Part
of the [User Guide](USER-GUIDE.md).

> **Beta.** Achievements is new and still settling: sets, points and scoring
> may change, and a result may be reset if a set is corrected.

## The Achievements window

**ACHIEVEMENTS** in the header, or **Cmd+Shift+O** (**Ctrl+Shift+O** on
Windows and Linux), opens a window with five tabs:

| Tab | What it shows |
| --- | --- |
| **GAME** | The loaded game's achievements and high scores. |
| **ACTIVITY** | Everyone's latest unlocks and scores, or only the loaded game's. |
| **CHAT** | The [chat](#chat). |
| **GAMES** | Every game with achievements. |
| **ACCOUNT** | Signing in, your passkeys and your recovery code. |

On a desktop the window floats over the running game: drag it by its title
bar, resize it from its edges, and it opens where you left it. The dock button
docks it on the right, full height, beside the app. In fullscreen it always
docks, opened by the trophy next to **✕**. On a phone it fills the screen, and
**Back** closes it. **Esc** closes it anywhere.

Typing in the window never reaches the C64. A player's name or a game title
opens their profile or the game's page, and **‹** goes back.

## Playing for achievements

Load a game from **GAMES** and play. Achievements count only with the exact
file the set is for: the **i** button at the right of the game's title shows
which version that is. Another release, or a copy that differs by a byte, has
none.

When a game with achievements loads, the window opens on its **GAME** tab. On
a phone or in fullscreen, the **ACHIEVEMENTS** button flashes three times
instead.

![The Achievements window docked beside Commando Arcade in play, on its GAME tab: the trophy HUD with 4 of 14 trophies lit and the next player to pass, the high scores and Trophy Hunters with five players and your own row highlighted, and the first trophies.](/guide/achievements-game.webp)

The **GAME** tab shows:

- **The trophy HUD**, as in [Retro Vibes](#trophies-in-retro-vibes): a slot per
  achievement with the next one marked, your points, and the chase of the next
  player to pass.
- **The high-score screens**, in the game's own style, with your row
  highlighted. Equal scores share a place. While you play, only the boards in
  play show, such as OutRun's route A, with a speedrun on top.
- **The trophies**: every one, what it takes, its points, and when you
  unlocked it.

A notification tells you when you unlock one. When a game ends, your score is
posted and the leaderboard keeps your best. Signed out, you see unlocks, and
they are saved when you sign in on this page.

Some games notice a trainer or cheat, such as unlimited lives, and C64 READY.
says so when it is on.

Only hardcore play counts in public. Loading a save state, or a trainer a game
notices, makes the game softcore until you reset the machine: what you unlock
stays on your own page, but not in Trophy Hunters or the activity, and scores
are not posted. Results that look unlikely wait for a check before they show.

With more than one game loaded, the one you are playing counts: a cartridge,
else the last one you put in. A game stays on while you turn its tape over or
change its disk. Ejecting its cartridge ends it, and so does a reset once none
of its files is loaded.

To play without achievements, turn them off in Options ▸ Other ▸
**ACHIEVEMENTS**. Nothing you load is looked at then.

### Toasts

Unlocks, posted scores and notices show as toasts for five seconds, one at a
time. The icon tells the kind: a trophy, a podium or a warning sign. Point at
one to keep it up.

Bigger unlocks get bigger moments, up to a shower of PETSCII characters at 50
points. A new best is stamped **BEST**. A new first place, or the unlock that
completes a game, turns the toast to gold.

Options ▸ Other ▸ **TOAST** places them on the screen, top center by default.
In [Retro Vibes](GUIDE-LOOKS.md#retro-vibes) its toast button lets you drag one
anywhere and resize it. The browser remembers both.

![Retro Vibes' IK+ Sunset with Commando Arcade in play on the TV, and a new first place toast at the top: turned to gold with a crown, stamped #1, PETSCII hearts, diamonds, spades and stars showering from it.](/guide/vibes-toast.webp)

### Trophies in Retro Vibes

While a game with achievements is loaded, [Retro Vibes](GUIDE-LOOKS.md#retro-vibes)
shows a trophy HUD: a slot per achievement and the next player to pass, on
a running speedrun when there is one. Its trophy button shows and hides it.

- **Drag** it anywhere. It snaps to the edges and the center.
- **Drag its corner** to reshape it: a bar, a box or a column, down to a pill.
  Phones and tablets get the bar, the slim column and the pill, with the HUD
  off at first.
- **⟲** turns it, **◐** fades it while you play, **✕** hides it.

An unlock's trophy flies into its slot. With the HUD hidden, the button's ring
shows your progress.

A challenge, such as a stage without a crash, goes out when you can no longer
earn it this time: its slot powers down and its card is stamped **OUT**. It
comes back when you can try again.

![Retro Vibes' IK+ Sunset with Commando Arcade in play on the TV. The trophy HUD runs along the foot: the game's icon and points, a slot per achievement with five lit and the next one marked, and the chase with the best score, fourth place and the next player to pass. An unlock toast lands at the top.](/guide/vibes-hud.webp)

### Attract mode

When a game ends, its high-score screen fills the window and cycles the board
you played, Trophy Hunters and your trophies, as an arcade does between
games. OutRun on route A shows route A, not the other routes. A game without a
score, such as The Last Ninja, shows it at its GAME OVER. Click the bars
under it to pick a page. Press **Space** to continue, or play again or click
beside it.

The screen button on the **GAME** tab, left of refresh, shows it any time, with
every board.

## Games with achievements

| Game | Achievements | High scores | The file it needs |
| --- | --- | --- | --- |
| 1943 | 14 | yes | OneLoad64 v5: `1943 - The Battle of Midway (J1).crt` |
| Action Biker | 41 | yes | OneLoad64 v5: `Action Biker.crt` |
| Arkanoid | 21 | yes | OneLoad64 v5: `Arkanoid (J1).crt`, or its crunched and uncrunched programs |
| Arkanoid: Revenge of Doh | 19 | yes | OneLoad64 v5: `Arkanoid - Revenge of Doh (J1).crt`, or its crunched and uncrunched programs |
| Barbarian: The Ultimate Warrior | 10 | yes | OneLoad64 v5: both `Barbarian - The Ultimate Warrior (Side 1)` and `(Side 2)` cartridges, or their crunched and uncrunched programs |
| Beach-Head | 10 | yes | OneLoad64 v5: `Beach-Head.crt` |
| Blue Max | 16 | yes | OneLoad64 v5: `Blue Max.crt` |
| Bomb Jack | 19 | yes | OneLoad64 v5: `Bomb Jack.crt` |
| Boulder Dash | 11 | yes | OneLoad64 v5: `Boulder Dash (J1).crt` |
| Bruce Lee | 10 | yes | OneLoad64 v5: `Bruce Lee (J1).crt` |
| Bubble Bobble | 14 | yes | OneLoad64 v5: `Bubble Bobble.crt` |
| Buggy Boy | 12 | yes | OneLoad64 v5: `Buggy Boy.crt` |
| Chuckie Egg | | yes | OneLoad64 v5: `Chuckie Egg.crt` |
| Commando | 14 | highest score, fastest 1st area | OneLoad64 v5: `Commando.crt` |
| Commando Arcade | 14 | highest score, fastest area 1 | Nostalgia's `CommandoArcade_N0S_EF.crt` or `CommandoArcade_N0S_FL_Universal.d64`, or OneLoad64 v5 extras: `Commando Arcade - Special Edition [EasyFlash].crt` |
| Cybernoid | 13 | yes | OneLoad64 v5: `Cybernoid.crt` |
| Cybernoid II | 10 | yes | OneLoad64 v5: `Cybernoid II.crt` |
| Defender of the Crown | 12 |  | OneLoad64 v5 extras: `Defender of the Crown [EasyFlash].crt` |
| Forbidden Forest | 16 | yes | OneLoad64 v5: `Forbidden Forest.crt`, or c64cade's cartridge |
| Galaga (Arlasoft) | | yes | OneLoad64 v5: `Galaga (Arlasoft - 2021).crt`, or c64cade's `galagaV106_FH.d64` |
| Ghosts 'n Goblins | 15 | yes | OneLoad64 v5: `Ghosts'n Goblins.crt` |
| Ghosts 'n Goblins Arcade | 10 | yes | OneLoad64 v5 extras: `Ghosts'n Goblins Arcade [EasyFlash].crt`, or `GHOSTNGA.D64` |
| Great Giana Sisters | 10 | yes | OneLoad64 v5: `Great Giana Sisters, The.crt` |
| Green Beret | 14 | yes | OneLoad64 v5: `Green Beret.crt`, or its crunched and uncrunched programs |
| Gribbly's Day Out | | yes | OneLoad64 v5: `Gribbly's Day Out.crt` |
| IK+ | 13 | yes | OneLoad64 v5: `IK+.crt`, or the disk `IKplus.d64` |
| Impossible Mission | 10 | yes | OneLoad64 v5: `Impossible Mission.crt` |
| Mario's Cement Factory | 15 | Game A and Game B | c64cade's PRG, or `mario-cf131.prg` |
| Mole Attack | | yes | OneLoad64 v5 extras: `Mole Attack.crt` (the official cartridge), or c64cade's PRG |
| Munchy Worm | | yes | c64cade's `munchyworm_1_01.d64` |
| Nemesis | 22 | yes | OneLoad64 v5: `Nemesis.crt` |
| Out Run | 22 | five routes | OneLoad64 v5: `Out Run (Route A) (J1).crt` through Route E, or MultiLoad64: `Out Run (by $olo1870) [EasyFlash].crt` (select routes 1 to 5) |
| Paperboy | 18 | yes | OneLoad64 v5: `Paperboy.crt`, or `AlternativeFormats/PRGs/Crunched/Paperboy.prg` or `AlternativeFormats/PRGs/Uncrunched/Paperboy.prg` |
| Panther | | yes | OneLoad64 v5: `Panther.crt`, or c64cade's cartridge |
| Paradroid | 11 | yes | OneLoad64 v5: `Paradroid.crt` |
| Pirates! | 25 | most Pirate Points | OneLoad64 v5 extras: `Pirates! [EasyFlash].crt`, with every trainer cheat set to NO |
| Rainbow Islands | 24 | yes | OneLoad64 v5 MultiLoad64: `Rainbow Islands (by $olo1870) [EasyFlash].crt`, or c64cade's copy |
| Rambo First Blood Part II | 17 | yes | OneLoad64 v5: `Rambo - First Blood Part II.crt` |
| Road Runner | | yes | OneLoad64 v5 MultiLoad64: `Road Runner (by $olo1870) [EasyFlash].crt` |
| Spy vs. Spy | 18 | fastest escape, highest score | OneLoad64 v5 cartridge, crunched or uncrunched program, source tape, or C64PP First Star M4 disk dumps |
| Spy vs. Spy II: The Island Caper | 18 | fastest submarine escape | OneLoad64 v5 cartridge, crunched or uncrunched program, source tape, or C64PP First Star disk dump |
| Spy vs. Spy III: Arctic Antics | 16 | fastest rocket escape | OneLoad64 v5 cartridge, crunched or uncrunched program, source tape, or C64PP First Star PAL disk dump |
| Stix | | yes | OneLoad64 v5: `Stix (J1).crt`, the official cartridge `Stix.crt` in the extras, or c64cade's PRG |
| Super Mario Bros 64 | 17 | yes | OneLoad64 v5: `Super Mario Bros 64 (Zeropaige - 2019).crt` |
| The Hitchhiker's Guide to the Galaxy | 22 | Fewest moves to 400 points | Release 47 disk: `hitchhikers_guide[infocom_1984](r47).d64` |
| The Last Ninja | 22 | fastest of each level | OneLoad64 v5 MultiLoad64: `Last Ninja, The (by $olo1870) [EasyFlash].crt` |
| The Way of the Exploding Fist | 10 | yes | OneLoad64 v5: `Way of the Exploding Fist, The.crt` |
| Thrust | | yes | OneLoad64 v5: `Thrust (J1).crt` |
| Turrican | 17 | highest score, fastest world 1 | OneLoad64 v5 MultiLoad64: `Turrican (by $olo1870) [EasyFlash].crt` |
| Turrican II: The Final Fight | 18 | highest score, fastest world 1 | OneLoad64 v5 MultiLoad64: `Turrican II (by $olo1870) [EasyFlash].crt` |
| Uridium | 22 | yes | OneLoad64 v5: `Uridium.crt` |
| Vegetables Deluxe | | Shopping, Classic and Countdown | c64cade's `vegdlxnointro.prg` |
| Wizball | 9 | yes | OneLoad64 v5: `Wizball.crt` |
| Yie Ar Kung-Fu | 12 | yes | OneLoad64 v5: `Yie Ar Kung-Fu.crt` |
| Zork I | 20 | Fewest moves to 350 points | `zorki-1541.d64` |

Action Biker, Chuckie Egg, Forbidden Forest, Galaga (Arlasoft), Gribbly's Day
Out, Mario's Cement Factory, Mole Attack, Munchy Worm, Panther, Rainbow
Islands, Road Runner, Stix, Thrust, Uridium and Vegetables Deluxe are ported
from [c64-cheevos](https://github.com/hayesmaker/c64-cheevos) by hayesmaker
(MIT), the achievements of [C64Cade](https://c64cade.com). The rest are made
for C64 READY.

## Activity, games and profiles

**ACTIVITY** lists everyone's latest unlocks and best scores. The button with
the loaded game's name narrows it to that game, and **LOAD MORE** at the
bottom brings older entries, a page at a time. A game's own activity, on its
page, pages the same way. A player keeps the same colour here and in the chat.

![The ACTIVITY tab, docked beside the app with Commando Arcade in play: players' unlocks and high scores, newest first, each with its points.](/guide/achievements-activity.webp)

**GAMES** lists every game with your progress: the loaded game first, then the
games you have played, most complete first, with when you last played them
where the window has room. **Filter
games** narrows the list by title. A game's page shows its high-score screen,
its Trophy Hunters, your achievements, its activity and the versions it accepts.
Its **i** button shows the versions, and **About the game** under them opens the
game's page on [Lemon64](https://www.lemon64.com) in a new window. When one of
those versions is in your **LOAD LIB** library, a **▷** button beside it loads
the game.

![The GAMES tab docked on the right of the app: a row for each game, with its pixel icon, its title, your count and a meter of your progress.](/guide/achievements-games.webp)

A player's profile shows their points, and their progress and best scores in
each game they have played.

## Chat

The chat is one conversation for everyone signed in. It connects only when you
open the **CHAT** tab.

![The CHAT tab docked beside Commando Arcade in play: three players talking, each with their badge, the first message mentioning Commando Arcade as a link in the game's colour. While the message box has the keyboard, the screen says to click it to give the keyboard back.](/guide/achievements-chat.webp)

### Joining

The chat needs an [account](#your-account), and your username is your name
there. Signed out, **SIGN IN** takes you to the ACCOUNT tab. Signing out
leaves the chat.

### Talking

| Control | What it does |
| --- | --- |
| **SEND** | Sends your message, up to 280 characters. |
| **🙂** | Picks an emoji for your message. |
| **PEOPLE** | Who is in the chat. Anyone whose connection dropped is marked away for a minute. |

Type **@** to mention a game with achievements. A list of matching games
opens as you type, with the loaded one first. Pick one with the arrow keys and
**Enter**, or a click. In the message the game shows as a link in its colour,
and clicking it opens the game's page under **GAMES**.

Unlocks and new best scores are in [ACTIVITY](#activity-games-and-profiles), not in the chat.
Closing the window does not leave the chat: the **ACHIEVEMENTS** button counts
new messages.

### Moderation

Under **PEOPLE**, next to each member:

- **hide** hides their messages on your screen, and **show** brings them back.
- **vote to remove** removes them for an hour once a majority of the others
  agree, and always at least two people. Connections from one place count as
  one vote.
- **report** sends them, with the recent messages, to the admin.

The admin can also mute, remove and ban, and delete messages.

## Missing a game?

A game has achievements when it has a set: a file naming the game, the exact
file it is for, and each achievement and high score as conditions on the
machine's memory. Anyone can ask for a set, or write one.

### Ask for a game

[Open an issue on GitHub](https://github.com/mortyeriksen/c64ready/issues/new)
with the game's title, the exact file name and its MD5 fingerprint:

| System | Command |
| --- | --- |
| macOS | `md5 "Ghosts'n Goblins.crt"` |
| Windows | `certutil -hashfile "Ghosts'n Goblins.crt" MD5` |
| Linux | `md5sum "Ghosts'n Goblins.crt"` |

Do not attach the game: it is copyrighted, and the fingerprint is all a set
needs.

### Write a set

1. Fork the [repository](https://github.com/mortyeriksen/c64ready) and add
   `server/sets/<game>.json`. The
   [server's README](https://github.com/mortyeriksen/c64ready/blob/main/server/README.md#achievement-sets)
   describes the format, and the sets in
   [`server/sets/`](https://github.com/mortyeriksen/c64ready/tree/main/server/sets)
   are examples.
2. Write the conditions in [rcheevos](https://github.com/RetroAchievements/rcheevos)
   syntax, as RetroAchievements does. Guard them so nothing fires on the title
   screen or in a demo.
3. Run `npm run dev`, load the game and play: your set shows under **GAMES**.
4. Add a test like `test/achievements/uridium-set-spec-test.js`, and open a
   pull request with the set and the test.

If your set builds on someone else's, name it and its license in `source`.

## Your account

An account is a username and a passkey: no password, no email. The passkey signs
you in with your device's fingerprint, face or PIN, and your browser or
password manager keeps it.

- **CREATE ACCOUNT** picks a username (up to 16 characters) and makes a passkey.
  **UPLOAD BADGE** there is optional.
- **SIGN IN WITH PASSKEY** uses a passkey on this device, or one from your
  phone.
- **SIGN OUT** signs this browser out. **DELETE ACCOUNT** deletes the account
  with its achievements and scores, and frees the name.

### Your badge

A badge is a picture of your choice. It shows on your profile and beside your
name in the activity. Add it on the sign-up form, or by clicking the badge
square on your own profile. It is shrunk to fit 256×256 in the browser before
it is uploaded, never cropped, and shows centred in its square. **remove
badge** takes it down.

### Your recovery code

A new account shows its **recovery code** once: twenty letters and digits.
Save it in your password manager or write it down. With your username, it
gets you back in if you lose your passkey. **NEW RECOVERY CODE** replaces it.

### More than one passkey

**ADD A PASSKEY** makes another, on a second device or a security key, so
losing one device does not lose the account. **Passkeys** lists them, and
**remove** takes one off. An account keeps at least one.

### Lost your passkey?

Open ACCOUNT, choose **Lost your passkey?**, and enter your username and
recovery code. **RECOVER** makes a new passkey on this device and signs you
in. The code works once, so save the new one it shows. After five wrong codes,
that address has to wait an hour.

## What is shared

C64 READY. fetches the list of games with achievements and compares your file
with it in the browser. Only a game on that list is looked up, so the server
never learns what else you load.

Your username, badge, achievements, best scores and activity are public.

The server keeps your username and badge, the public half of each passkey, a
fingerprint of your recovery code (not the code), your sessions, and your
achievements, scores and activity. Each sign-in, recovery and sign-out is
logged with your IP address and browser for 90 days, readable only by the
admin. Deleting the account deletes all of it.

In the chat, your name is visible while you are connected, and your messages
go to everyone and to the admin. The admin sees a short code made from your IP
address, not the address. The chat server logs messages, joins, leaves and
moderation with your username and IP address for 90 days. Only the admin
can read the log, and it is shared only when the law requires it. The last 100
messages are kept in memory until the server restarts.
