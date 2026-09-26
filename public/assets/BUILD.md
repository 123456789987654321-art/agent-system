> Legacy 3D assets: the active page uses an original inline SVG portrait. See `docs/avatar-2d.md`. These 3D assets are not loaded.

# Rebuilding the digital human

The runtime uses `home-assistant.glb`, `home-assistant.webp`, and
`../avatar-rig.mjs`. The GLB retains the A-pose bind skeleton; the runtime applies
a relaxed pose without rebinding the skin or modifying wrist/finger rotations.

Run from the repository:

```powershell
node scripts/build-avatar.cjs
# Or produce a candidate without replacing the runtime asset:
node scripts/build-avatar.cjs output/avatar-repair/candidate.glb
npm test
```

The build uses the existing local source-asset workspace, which is not part of
the deployed application:

- `output/avatar-review/source-model.glb`: the original CC0 MPFB character.
- `output/fullbody-review/`: `base.obj`, `fem_suit2.obj`,
  `toigo_female_suit_2.mhclo`, `Fsuit2.png`, `flats.obj`, `toigo_flats.mhclo`.
- `output/portrait-review/`: `GingerHair.png`, `bob_curled_under.obj`,
  `toigo_curled_under_bob.mhclo`.
- `output/avatar-tools/node_modules/`: dependencies from that workspace's
  `package.json` and lockfile (`@gltf-transform/*`, `three`, `sharp`,
  `meshoptimizer`). Run `npm ci --prefix output/avatar-tools` if needed.

See `ATTRIBUTION.md` for sources and licenses. A fresh checkout without these
local source assets can serve the checked-in GLB; rebuilding requires restoring
the source workspace first.

Shoulders and sleeves use the garment author's body correspondences, blended
into the existing torso fit. The original outfit remains a source for torso
weights because the original body has no covered torso surface; its render node
is removed before export. The body coverage mask is applied before compression.
Do not replace the torso's weight source with only the cut-away body, or fit the
entire sleeve from nearby torso vertices.

The build then applies `scripts/avatar-proportions.cjs` to the complete clothed
character: narrower shoulders, slimmer sleeves and reduced upper-torso depth,
with the head and overall height preserved. Joint anchors and inverse bind
matrices are updated together with the meshes and expression deltas. Do not
scale only the jacket or apply a global runtime width scale.

After changing the model, inspect front and both oblique views with the runtime
pose, inspect desktop/mobile light/dark pages, render a new transparent fallback
via `HomeAvatar.capture()`, and update the asset versions in `avatar.js` and
`index.html`. The fallback must show the same model and pose as the live canvas.
