# Shape morph loop

One shape, never cut: button → loader → check → dynamic island → player (play/pause, scrub) →
volume slider (rubber-band past max) → toggle → liquid tabs → chart + tooltip → ⌘K → toast → button.
120 BPM, 7 bars, 1440×1440, 60 fps, seamless loop.

- `index.html` — the whole animation. `seek(t)` is a pure function of time: every value is a sum of
  closed-form spring step responses (periodic, so the loop has no seam), drags are direct overrides
  that spring back from the release point. Open it in a browser and call `seek(t)` from the console.
- `audio.py <song>` — numpy beat grid (spectral-flux tempo, sample-accurate phase, harmonic-change
  downbeat), cuts 28 beats from the loudest downbeat-aligned window, places UI sounds by measured peak.
  Writes `audio/beats.json` + `audio/mix.wav`.
- `render.cjs [out.mp4]` — Playwright, 4 subframes per frame, ffmpeg `tmix` for motion blur.
- `stills.cjs <dir> [t,t,…]` — one frame per beat for review. `loopcheck.cjs` — verifies the seam.

```sh
pip install numpy imageio-ffmpeg
python3 placeholder.py                     # stand-in track until the Mixkit song is available
python3 audio.py audio/placeholder_120.wav # or: python3 audio.py path/to/mixkit-song.mp3
node render.cjs out/loop.mp4
```
