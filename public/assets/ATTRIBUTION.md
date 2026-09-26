# Digital human asset

`home-assistant.glb` is derived from the CC0 `mpfb.glb` avatar in
https://github.com/met4citizen/TalkingHead/tree/main/avatars

The upstream README identifies this model as created with Blender / MPFB
(MakeHuman Plugin for Blender) and released under CC0:
https://github.com/met4citizen/TalkingHead#avatars
https://creativecommons.org/publicdomain/zero/1.0/

Wardrobe: 'toigo_female_suit_2' and 'toigo_flats', by Margaret Toigo (MRT),
released under CC0 in the official MakeHuman Community packs:
https://static.makehumancommunity.org/assets/assetpacks/suits01.html
https://static.makehumancommunity.org/assets/assetpacks/shoes01.html

Changes: replace the casual outfit with a navy trouser suit and dark leather
flats; fit the shoulders, full sleeves and collar with the authored body
correspondences, smoothly blend the fit into the tailored torso, smooth
transferred skeleton weights across the shoulders, preserve the original outfit
as a weight source for the cut-away torso (not as a rendered mesh), and apply
a relaxed arm pose with forward elbow bends; retain seven facial expression channels, remove unused data, resize
textures to at most 2048 pixels, convert textures to WebP, and compress geometry
with Meshoptimizer. The static fallback is rendered from this same model.
No Youyan models, likenesses, images, or services are included.

Renderer: Three.js 0.180.0 (MIT; see ../vendor/three/LICENSE).
Decoder: Meshoptimizer 1.3.0 (MIT; see ../vendor/meshoptimizer/LICENSE.md).
