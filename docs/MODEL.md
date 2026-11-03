# Renderers, equations, provenance and limitations

Distortion Lab has two deterministic renderers. Each reconstruction records its
renderer ID and version (`renderer`, `rendererVersion`), so a saved session
always identifies the equations that produced its pixels. The browser
(`web/js/core.js`) and the Python backend (`distortion_lab/model.py`) implement
the same arithmetic. `tests/test_parity.py` checks that they produce identical
pixels (see [TESTING.md](TESTING.md)).

## Shared conventions

- Coordinates `(x, y)` are in **nominal visual degrees**. The origin is the aperture centre and **y is positive upward**.
- Angles and phases are stored in **degrees**. Frequency is cycles per nominal degree.
- An n × n raster spans the aperture diameter `D`. Pixel `(i, j)` (row `j` counted from the top) samples its centre:
  `x = ((i + 0.5)/n − 0.5)·D`, `y = (0.5 − (j + 0.5)/n)·D`.
- Common aperture `A(x, y)`: 0 when `x² + y² > D²/4`. Inside, it is 1 (circular) or `exp(−(x² + y²)/(2σ²))` (Gaussian; an extension).
- Encoded grey level: `pixel = round(127.5 · (1 + c · A(x, y) · P(x, y)))`, where `round` is round-half-up (JavaScript `Math.round`) and `P ∈ [−1, 1]`.
  This is the encoded value before any display gamma. No gamma or timing calibration is provided.
- The reference grating is always rendered as one legacy component `{θ, f, φ, K = 0, T = 1, W = 1}` with the reference contrast.

## 1 · `legacy-rectified` 1.0.0 (original synthesis, advanced family)

This is backward-compatible with the original prototype
(`existing-prototype/distortion-lab-presets.html`). The arithmetic is unchanged,
and all ten saved preset PNGs are reproduced pixel for pixel in both JS and Python.

```
G_i(x,y) = cos(2π f_i (−x sin θ_i + y cos θ_i) + φ_i)
F_i      = clip(G_i + K_i, −T_i, T_i)
P        = clip(Σ_i W_i F_i, −1, 1)          (enabled components only)
```

The JSON field `duty` is **K** (an offset, not a duty-cycle percentage), `threshold` is **T** and `weight` is **W**.
W is direct and **not normalised**. At most 12 components are allowed. The interface bounds are θ 0–180 (step 0.1),
f 0.1–24 (step 0.01), φ 0–360 (step 1), K −1…1, T 0–2 and W 0–20 (steps 0.01). These are interface bounds, not physiological ones.

This implements the image-synthesis family of Olianezhad et al. (2025) Eqs. 1–2, plus our explicit final clip at ±1.
It does **not** implement Eq. 3's stimulus-derived weights, the authors' optimiser or their neural cortical-spread
model. Similar images can arise from different component decompositions. Raw component parameters should not be read as
uniquely identified perceptual or neural measurements.

**Mixing** (`Adjust → Mix original forms`) concatenates the components of two forms, with weights scaled by `wa` and `wb`.
The result is limited to 12 components. Pins are respected, and the mix is refused when it is impossible.

## 2 · `semantic-grating` 1.1.0 (explicit appearance generator)

This renderer is **not part of the published model**. It exists so that participant-facing, higher-order controls
change the advertised property directly. It uses one carrier grating with documented geometric operations.
`tests/core.test.js` checks each operation against the equations below.

With `θ` = stripe orientation:

```
u = −x sin θ + y cos θ          across-stripe coordinate (deg)
v =  x cos θ + y sin θ          along-stripe coordinate (deg)
```

**Displacement across the stripes** (sum of the active terms, in degrees):

```
bend:    d_b = A_b · sin(2π v / λ_b + φ_b)
zigzag:  d_z = A_z · [(1 − s) · tri(t) + s · step(t)],   t = v / λ_z + φ_z / 360
         tri(t)  = (2/π) asin(sin 2πt)                   (triangle wave → zigzag corners)
         step(t) = tanh(12 sin 2πt) / tanh(12)           (near-square wave → steps)
offset:  d_o = A_o · (H(w) − ½),   w = v cos α + u sin α − b
         H = unit step (w ≥ 0), or ½(1 + tanh(w / softness)) when softness > 0
```

**Limiting a feature to one side of the boundary line** (added in 1.1.0): the offset boundary `w = 0` defines a line
across the stripes, whether or not `offsetAmount` is 0. Bending, zigzag/steps, breaks and crossing lines each have an
"applies to" setting (`bendSide`, `zigSide`, `fragSide`, `crossSide`): `whole`, `upper` or `lower`. The feature is
multiplied by `1`, `H(w)` or `1 − H(w)` respectively, so with zero boundary softness it stops exactly at the line.
"Upper" is the side the stripe direction points to: above the line for any non-horizontal stripes, and to the right for
exactly horizontal stripes. Sessions made with 1.0.0 are migrated automatically by adding `whole` to each, which is
pixel-identical (tested).

**Carrier and profile**

```
s = u + d_b + d_z + d_o
P = profile(cos(2π f s + φ)),   profile(g) = g if sharpness = 0, else tanh(k g)/tanh(k), k = 20·sharpness
```

When all distortions are zero and sharpness is 0, `P = cos(2π f u + φ)`. That is exactly the legacy single-component
reference. Tests check that the "Unchanged reference" tile is pixel-identical to the reference grating.

**Breaks (fragmentation)**: each stripe cycle `n = floor(f s + φ/360)` (one dark bar between light peaks) is cut
along its length:

```
τ = v / L + jitter · hash01(n, seed);   if frac(τ) < extent:  P = gapFill
```

`hash01` is a fixed 32-bit integer hash. It is identical in JS and Python, so a given seed always gives the same break pattern.

**Crossing pattern**:

```
G_c = cos(2π (−x sin(θ+Δ) + y cos(θ+Δ)) / λ_c + φ_c)
P   = clip(P + κ · profile(G_c), −1, 1)
```

`Δ` is the crossing angle relative to the stripes, `λ_c` the crossing period (deg per cycle) and `κ` the strength.

**Gap / missing area**: a signed distance `dist` (negative inside) to a disc (radius r), a band (half-width r through
the centre at angle α) or a three-branch "Y" (three rays at α, α+120°, α+240° with half-width r):

```
m = 1 if dist ≤ 0 (softness 0)  else  clamp(½ − dist/softness, 0, 1)
P = P + m · (1 − residual) · (gapFill − P)
```

`residual` = stripe visibility inside the gap (0 = fully replaced, 1 = untouched). `gapFill` = luminance of the gap
(+1 white, the default and the analogue of the original white holes; 0 = mean grey; −1 black).

The order of operations is: displacements → carrier/profile → breaks → crossing → gap → aperture and contrast.

### What the controls mean

| Participant-facing control | Changes |
|---|---|
| Bend amount / spacing | `A_b` (peak sideways displacement, deg) / `λ_b` (wavelength along the stripe, deg) |
| Zigzag/step strength / spacing / corner style | `A_z` / `λ_z` / `s` (0 = zigzag, 1 = steps) |
| Offset amount / boundary position | total sideways jump `A_o` across the boundary / boundary position `b` along the stripes |
| … applies to (bend, zigzag, breaks, crossing) | whole picture, or only the upper/lower side of the boundary line |
| Break extent / spacing | fraction of each stripe removed / repeat length `L` |
| Gap size / position / stripe visibility inside gap / shape | `r` / `(x₀, y₀)` / `residual` / disc, band or branch |
| Crossing strength / angle / spacing | `κ` / `Δ` / `λ_c` |
| Stripe orientation / frequency / phase / contrast | `θ`, `f`, `φ`, `c` |

Advanced controls (shown with "more controls") are bend/zigzag/crossing position, boundary tilt and softness, break
irregularity and seed, gap orientation and edge softness, gap/break brightness, and edge sharpness.

The full ranges, steps and defaults are in [PARAMETERS.md](PARAMETERS.md), generated from `shared/parameters.json`.

## Plaid gallery items

The 7 plaid starting points are drawn with the original synthesis renderer: two components with `K = 0`, `T = 1` and
`W1 + W2 ≤ 1`, so `P = W1·G1 + W2·G2` exactly, a linear sum of two sinusoidal gratings. They follow the phantom
categories described by Maruya et al. (bioRxiv 2025, doi:10.1101/2025.06.24.661078): net-like, soft bands, shifts at
small, larger and oblique angles, interrupted, and wavy. They are built relative to the test grating; the parameters
are our approximations, not the authors' values (`shared/parameters.json` → `gallery.plaids`). Each component's
orientation, frequency, phase and weight (contrast) can then be adjusted, as in their 8-slider refinement.

## Nulling (making it look straight)

Matching asks what the test grating looks like to the amblyopic eye. **Nulling** asks which picture would look
*straight* to an eye. The Nulling tab sets:

- **Adjusted eye:** amblyopic or fellow.
- **Standard:** a straight grating in the other eye, or **nothing**. With nothing, the other eye sees mid-grey and the
  criterion is "looks straight". Use this when both eyes may be distorted, e.g. on psilocybin.
- **Starting point:** a straight grating, or the **reverse** of a matched distortion (`reverseRecon` in `web/js/core.js`):

| Matched feature | Reverse used as the starting point | When it can cancel |
|---|---|---|
| Tilt `θ`, spacing `f`, position `φ` | `2θ_ref − θ`, `f_ref² / f`, `2φ_ref − φ` | if the eye rotates, scales or shifts the stripes |
| Bend, zigzag/steps | same amplitude, position + 180° (displacement `−d(v)`) | if the displacement is stable and tied to visual-field position (it depends only on position along the stripes) |
| Offset | `−offsetAmount` | as above |
| Crossing lines | same pattern in counter-phase | only if the extra pattern adds linearly |
| Lower contrast | contrast `c_ref² / c` (≤ 1) | if contrast is scaled |
| Breaks, gaps, edge sharpness | removed (reported) | cannot be reversed: missing information |
| Original/plaid renderer | linear prediction `N = 2S − P`: the test grating at twice its contrast plus every matched component negated (phase + 180°, `K → −K`) | exact before the final ±1 clip if the eye were linear (e.g. Maruya et al.'s linear-filter account); approximate if components clip |

Each repeat is recorded in `nulls` with: eye, standard, starting point, repeat number, the start and final pictures,
the matched picture it came from, the result (*looks straight*, *can't be made straight*, *keeps changing*,
*can't tell*) and an optional **other-eye check**. The check shows the null picture to the other eye, which should see
it distorted the opposite way. Repeats alternate the starting point by default, to reduce bias towards the start.
Ending nulling restores the matched reconstruction (undoable). No matching data is changed or removed.

## Proposals (comparison-driven refinement)

Proposals are deterministic and seeded. They are not AI-generated images.

- **Eligible fields**: numeric fields in the chosen focus. "Properties shown in Adjust" means global plus active and revealed families.
  You can also choose one family or everything. Pinned fields are always excluded. Advanced fields are included only when "more controls" is on.
- **Generator**: `mulberry32(seed)` shuffles the eligible fields. Candidates alternate between a single-parameter change
  and a **coordinated two-parameter change**. Each change is `sign · max(step, m · scale · (0.75 + 0.5·r))`, where
  `m` = the field's `proposal` magnitude (or `proposalRel·|value|` if larger), `scale` = 1 (coarse) or 0.25 (fine) ×
  `shrinkFactor^round`, and `r ~ U(0, 1)` from the same generator. Values are wrapped for periodic fields, then clamped and quantised. If one direction is blocked
  by a bound, the other direction is tried. Duplicate candidates are dropped.
- **Repeated neighbourhoods**: "More, closer to current" increments `round` while the anchor (the version last chosen or kept) is unchanged.
  Any manual edit or new starting point resets it.
- **Recording**: every set records `seed`, all settings, the base state, all candidates and the choice (`keep`, a candidate id, or none).
  Regenerating with the recorded settings reproduces the set exactly (tested).
- **Preview**: clicking a candidate shows it in the main view and, optionally, in the stimulus window without changing the
  reconstruction. Each preview is logged (`preview-candidate`).
- **Choice**: choosing replaces the reconstruction (one undo entry) and the sliders show the new values. "Keep current" changes nothing.
  A choice can be made whenever the reconstruction equals the set's base version: after *Keep current*, or after undoing a
  choice. Every choice is recorded in `choices` (with `choice` = the latest). Otherwise the set cannot be applied.

## Pins and compositions

Pinned fields cannot be edited from sliders, dials or the API until they are unpinned, and they are never changed by
proposals, AI operations, gallery choices or combinations. When a composition would set a pinned field, the pinned value
is kept and recorded (`keptPinned`). When a pin cannot be honoured, the operation is **refused with an explanation**
and the state is unchanged. This happens when switching renderer while pins exist, when a legacy form lacks the
pinned component, or when removing a component with pinned fields.

## Provenance of the original forms

The ten "Barrett-inspired" original forms (`shared/legacy-presets.json`) are **independent illustrative constructions**
within the rectified-grating synthesis family. They are not the authors' fitted parameters, clinical scotomas,
participant percepts or validated replicas. Each preset's own notes state its limitations. In particular:

- **Abrupt offset / seam** is an approximation. A beat-related seam with residual interference is not an independently positioned displacement.
- **Three-branch white gap** is a partial approximation. The surviving stripes share one carrier orientation, unlike the published Y-shaped example.
- White holes are image regions created by addition and saturation. They are not simulated or diagnosed scotomas.

Source: Olianezhad et al. (2025), *Visual Distortions in Human Amblyopia Are Correlated with Deficits in Contrast
Sensitivity*, J. Neurosci., DOI [10.1523/JNEUROSCI.1111-25.2025](https://doi.org/10.1523/JNEUROSCI.1111-25.2025),
PMC12590119. Maruya et al. (PMC12262670) used preset selection followed by dichoptic plaid matching. That is a different
study and procedure, and nothing here implements or claims to replicate it.

The semantic generator's masks and warps are **our** constructions and are not claimed to be part of the original paper model.
The gallery's family names are descriptive labels for the researcher, not a validated taxonomy.

## Limitations

- These are software and image-generation tools. No software test establishes perceptual validity, uniqueness of a match,
  or equivalence between a reconstruction and a percept.
- Geometry is nominal: diameter and pixels-per-degree must be measured through the actual stereoscope.
  Screen position does not isolate the eyes; the mirror stereoscope does. Eye labels (AE/FE) are recorded metadata.
- No gamma linearisation, luminance calibration or frame-timing validation is provided. The sequential mode's alternation
  uses browser timers and is not timing-validated.
- Sampling: high frequencies or strong clipping can alias at low pixel density. The console warns when a carrier exceeds
  ¼ or ½ of the raster sampling rate.
- The semantic generator's parameters are appearance parameters. Different settings can look alike, so treat the
  reconstructed image, not any single number, as the primary record.
