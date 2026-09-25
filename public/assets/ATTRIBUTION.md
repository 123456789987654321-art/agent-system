# Digital human asset

`home-assistant.glb` is derived from the CC0 `mpfb.glb` avatar in
https://github.com/met4citizen/TalkingHead/tree/main/avatars

The upstream README identifies this model as created with Blender / MPFB
(MakeHuman Plugin for Blender) and released under CC0:
https://github.com/met4citizen/TalkingHead#avatars
https://creativecommons.org/publicdomain/zero/1.0/

Changes: remove the shirt graphic, recolor clothing, adjust the runtime arm pose,
retain seven facial expression channels, remove unused data, resize
textures to at most 1024 pixels, convert textures to WebP, and compress geometry
with Meshoptimizer. The static fallback is rendered from this same model.
No Youyan models, likenesses, images, or services are included.

Renderer: Three.js 0.180.0 (MIT; see ../vendor/three/LICENSE).
Decoder: Meshoptimizer 1.3.0 (MIT; see ../vendor/meshoptimizer/LICENSE.md).
