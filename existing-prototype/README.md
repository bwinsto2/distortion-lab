# Barrett-inspired form explorations

Open **distortion-lab-presets.html** in a modern browser. It is self-contained and works offline. Choose a form under **Barrett-inspired starting forms**, then click **Apply form**. **View gallery** previews all ten. Each component remains editable; select C1, C2, etc. to change it. The buttons at the top show the left, right, both, or neither stimulus. Applying a form keeps the current eye routing, pixel calibration, visibility, and accepted records, and changes the reference, model, aperture, and nominal diameter.

The saved examples use circular gratings to follow the paper's presentation. Select **Gaussian (Gabor)** under Optical layout to apply a common Gaussian window. These are summed carriers with one common aperture, rather than independently positioned Gabor patches.

## What is saved

- `presets/`: ten individual session JSON files. Open one with **Load JSON** in the included GUI. These restore the whole saved session, including nominal display geometry; they contain no participant records. Reapply your measured calibration after loading.
- `images/`: a separate 512 × 512 PNG for each adjustable stimulus, rendered from the saved parameters.
- `barrett-inspired-gallery.png`: a labeled overview exported by the GUI.
- `preset-library.json`: all predefined forms and explanatory notes in one machine-readable file. This is a preset manifest; the GUI's Load JSON button expects the individual session files instead.
- `parameter-table.csv`: exact component parameters for all examples.

To preserve your own edits, use **Save session JSON**. **Export adjustable stimulus PNG** saves the current model alone; **Export visible display PNG** saves the two-panel display. The predefined examples are not overwritten when you adjust them.

## Forms and how they are made

These are independent illustrative constructions within the implemented synthesis family. They are **not the authors' fitted parameters, participant matches, or validated replicas of Barrett's drawings**. The names are descriptive, not a claim that all ten are distinct official Barrett categories.

| Form | Components | Construction and limits |
| --- | ---: | --- |
| Undistorted reference | 1 | Physical identity with the reference carrier. |
| Misorientation | 1 | A uniform 25° difference from the reference. Does not demonstrate a local orientation patch. |
| Wavy stripes | 3 | One carrier and two oblique sidebands approximate sinusoidal phase modulation, then output saturation sharpens the bars. |
| Stepped / angular stripes | 11 | One oblique carrier and five pairs of sidebands approximate square-wave phase modulation. Finite Fourier approximation leaves some ringing and rounded corners. |
| Abrupt offset / seam | 2 | Nearly aligned, oppositely biased clipped carriers create a beat-related seam. An approximation: the seam has residual interference and is not a freely positioned displacement boundary. |
| Fragmented bars | 2 | A vertical carrier plus a lower-frequency horizontal component leaves separated dark fragments. |
| Crossed / added orientation | 3 | Two rectified orientations plus a slowly varying bias component make intersecting dark bars. |
| Central white hole | 3 | A vertical carrier plus two very low-frequency components saturates a rounded central region to white. |
| Broad missing band | 2 | A low-frequency horizontal component saturates a broad band across a vertical carrier. |
| Three-branch white gap | 4 | Three low-frequency components with alternating phases create a branching blank region over one carrier. A **partial approximation**: the surviving stripes all share one carrier orientation, unlike the multiple surviving orientations in the published Y-shaped example. |

The holes are white image regions created by addition and saturation. They are not independently painted masks and do not establish how an observer experiences a missing region or clinical scotoma. Their tapered stripe endings are part of this construction.

## Mathematical implementation

For each component, the carrier is a unit cosine:

`G_i(x,y) = cos(2π f_i [-x sin(θ_i) + y cos(θ_i)] + φ_i)`

Angles and phase in saved files are degrees; frequency is cycles per nominal visual degree. `y` is positive upward. The code then computes:

`F_i = clip(G_i + K_i, -T_i, T_i)`

`P = clip(sum_i W_i F_i, -1, 1)`

`image = 127.5 * [1 + contrast * aperture(x,y) * P]`

The JSON field `duty` is the offset **K**, not a duty-cycle percentage. `threshold` is **T**, and `weight` is **W**. Weights are not normalized. Pixel values are rounded to encoded grayscale.

The application implements the image-synthesis structure of Olianezhad et al. (2025), Eqs. 1–2, with a fixed final clip at ±1 and directly adjusted weights. It does **not** implement Eq. 3's stimulus-derived convolution weights, the authors' optimizer, or their neural cortical-spread model. The Gaussian aperture is an optional extension. The output saturation is our explicit implementation choice.

This version extends the interface to **12 components** and **weights 0–20** so that sharp constructions can be explored. These interface ranges are not physiological parameter bounds or an assertion about the number of components the paper needed. The stepped construction is a Fourier approximation, not evidence that eleven neural channels generated that percept. A more task-specific parameterization could express the same stepped form with fewer participant-facing controls.

All saved numbers lie on the GUI slider steps: orientation 0.1°, frequency 0.01 cycles/°, phase 1°, and K/T/W 0.01. The PNGs use those same rounded values. The eleven-component example contains relatively high-frequency sidebands; use sufficient calibrated raster resolution when inspecting it. Clipping adds harmonics beyond the carrier frequencies.

## Interpretation for percept matching

Treat these examples as starting points for checking what the synthesis family can express. Similar output images can have different component decompositions, and extra components increase flexibility. Consequently, raw fitted component parameters should not automatically be treated as uniquely identified perceptual or neural measurements. Repeated matching and comparison of reconstructed images or explicitly defined image features will be needed for that use.

The circular diameter of 3.2° and the pixels-per-degree values are nominal until calibrated through the actual stereoscope. The application does not supply gamma calibration or experimental timing validation.

## Source

Olianezhad et al. (2025), *Visual Distortions in Human Amblyopia Are Correlated with Deficits in Contrast Sensitivity*, Journal of Neuroscience. DOI: https://doi.org/10.1523/JNEUROSCI.1111-25.2025

Model figure used as a visual reference while developing examples: https://pmc.ncbi.nlm.nih.gov/articles/PMC12590119/figure/JN-RM-1111-25F3/

The source figure is not included in this package. All stimulus images here are newly rendered independent examples. No exact reconstruction or exhaustive coverage of the published forms is claimed.
