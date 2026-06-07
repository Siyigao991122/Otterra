Place the IKEA source images for `FRIHETEN / KLAGSHAMN` in this folder.

Required filenames:

- `front.jpg` - straight-on sofa view
- `side.jpg` - left or right profile view
- `angle.jpg` - 3/4 view showing depth and chaise shape

Recommended source:

- Save high-resolution product gallery images from:
  `https://www.ikea.com/us/en/p/friheten-klagshamn-sleeper-sectional-3-seat-w-storage-faringe-light-gray-s49520240/`

Notes:

- Use images of the same configuration and cover color when possible.
- Avoid screenshots with UI chrome or large text overlays.
- After these files exist, run:
  `node pipelines/trellis/pipeline.mjs check`
