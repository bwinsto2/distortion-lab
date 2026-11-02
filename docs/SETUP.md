# Lab setup: Linux desktop, mirror stereoscope, knobs and buttons

## Hardware

- **Stereoscope monitor:** the monitor viewed through the mirror stereoscope. Each eye sees one half of it.
- **Researcher monitor:** a second monitor for the console. Set the displays to **extended** ("join displays"), not mirrored.
- **USB MIDI controller with endless knobs and buttons**, for example a Behringer X-Touch Mini. Ordinary knobs that
  stop at the ends also work, but their value can jump when the app changes a setting by itself (Undo, choosing an
  alternative). Until it arrives, the keyboard does everything (see below).

## One-time software setup (Linux)

1. Install Google Chrome or Chromium if it isn't there. Chrome is needed for the MIDI controller.
2. Get the app (once):
   ```bash
   cd ~ && git clone https://github.com/bwinsto2/distortion-lab.git
   ```
3. Add menu and desktop launchers:
   ```bash
   cd ~/distortion-lab && sh tools/install_linux_launcher.sh
   ```
4. Optional, for AI suggestions on your Claude plan: install Claude Code (`curl -fsSL https://claude.ai/install.sh | bash`),
   then run `claude` once and sign in with your Claude account (see [AI_BRIDGE.md](AI_BRIDGE.md)).

The launchers run `git pull` first, so the computer always runs the latest version. To open the app in Chrome when it
isn't the default browser, start it from a terminal with `BROWSER=google-chrome ./start.sh` (or `chromium`).

## Each session

1. Start **Distortion Lab** (or **Distortion Lab (with Claude)**) from the applications menu or desktop.
2. In the browser, enter the **participant ID, session and amblyopic eye**. The reference grating goes to the amblyopic
   eye's half of the stereoscope screen and the reconstruction to the fellow eye's half.
3. Click **Open stimulus window**, drag it onto the stereoscope monitor and press **F** for fullscreen.
4. Check the alignment and size through the stereoscope (Experimenter tab → optics: separation, vertical offset,
   diameter, px/°).
5. Experimenter tab → **Participant controls on**.

## What the participant sees and does

| | Amblyopic-eye half | Fellow-eye half |
|---|---|---|
| **Amblyopic eye** view | reference grating | plain mid-grey |
| **Fellow eye** view | plain mid-grey | reconstruction, with a small dim menu below it (never over the grating) |

Blank halves stay at the same mid-grey as the background, so switching doesn't cause flashes.

- **Adjust mode:** the menu shows the highlighted control (e.g. "Bend amount", with a bar) and, faintly, the controls
  before and after it. Turning the knob changes it live; pressing the knob moves to the next control. Fixed (pinned)
  controls say "(fixed)". The list is the same as the console's Adjust tab, so the researcher can add a feature there
  (e.g. "+ Gap") and it appears in the participant's list.
- **Compare mode:** turning the knob flips the grating itself through the current version and versions A–D, all in the
  same place. Pressing the knob chooses the one showing. **New alternatives** makes a new set close to the current
  version; repeated presses get closer each time. Suggestions from the AI bridge arrive here too.

| Control | Action |
|---|---|
| Main knob, turn | change the value (Adjust) / flip through versions (Compare) |
| Main knob, press | next control (Adjust) / choose (Compare) |
| Button | Switch eye |
| Button | Adjust ↔ Compare |
| Button | New alternatives |
| Button | Undo |
| Optional second knob | choose which control (Adjust) |

**Setting up the controller:** Experimenter tab → **Connect MIDI controller** (allow MIDI when the browser asks) →
**Set up buttons and knobs…**, then follow the steps: turn or press each control once. The setup is remembered on that
computer. For the X-Touch Mini, use its **MC mode** (the "MC" button), where the knobs send relative turns.

**Keyboard** (works in the console outside text boxes, and in the stimulus window):
← → turn the knob (Shift = 5 clicks) · ↑ ↓ choose control · Enter = press knob · Space = switch eye ·
M = Adjust/Compare · N = new alternatives · Z = undo.

## The researcher's part (console)

The researcher types the participant's description while they talk (*Still different?* tab), can ask for AI
suggestions, add a feature type, pin something, record the outcome, and sees everything the participant sees in the
stimulus preview. Optics, eye routing and calibration are kept when the form changes.
