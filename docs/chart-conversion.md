# Chart conversion

The plugin converts S-57 ENC, BSB/KAP raster charts, pilot charts and
shapefile basemaps to MBTiles inside the Signal K process. Nothing else has to
be installed: no Docker or Podman, no helper container image, no
`signalk-container` plugin, no GDAL or tippecanoe on the host. A Raspberry Pi,
a Signal K container and a bare-metal server convert the same way.

Up to 2.x every conversion ran GDAL and tippecanoe in a helper container,
which needed a container runtime on the host and a peer plugin to reach it,
and failed in ways that were hard to diagnose (socket permissions, host paths
that differ from the paths Signal K sees, the file ownership of a rootless
container).

## The pieces

```
              ┌─────────── conversion worker threads (worker-pool.ts) ───────────┐
 .000 / .kap  │  GDAL (gdal3.js,       GeoJSON    vector tiler                    │
 .shp ──────► │  WebAssembly)  ──────────────────► bucket → tile shards → merge   │──► .mbtiles
 .tar.xz      │  one instance per worker           (geojson-vt + vt-pbf)          │
              │                                    raster overviews (pngjs/jpeg)  │
              └───────────────────────────────────────────────────────────────────┘
```

- **GDAL in WebAssembly** (`src/utils/gdal-wasm.ts`). The
  [gdal3.js](https://gdal3.js.org/) package is GDAL compiled to WebAssembly,
  with the S-57, BSB, MBTiles, GeoJSON and shapefile drivers. The plugin
  drives GDAL's C API directly (`GDALVectorTranslate`, `GDALTranslate`,
  `GDALRasterize`) rather than gdal3.js's helpers, which fix all output under
  one directory and cannot pass dataset open options; the S-57 sounding layer
  needs `SPLIT_MULTIPOINT` and `ADD_SOUNDG_DEPTH`. Host directories are
  mounted into the Emscripten file system with NODEFS, so GDAL reads and
  writes the real files in place: a chart larger than the WebAssembly heap
  still converts.
- **Worker threads** (`src/utils/worker-pool.ts`,
  `src/utils/conversion-worker.ts`). Each conversion opens a pool sized by the
  CPU budget (`concurrency.ts`), and each worker loads its own GDAL instance on
  first use. The pool closes when the conversion ends, which frees the
  WebAssembly heaps (they never shrink). Cancelling a conversion terminates its
  workers, so a GDAL call or a tiling shard stops at once.
- **Vector tiler** (`src/utils/vector-tiler.ts`,
  `src/utils/vector-tile-shard.ts`), the replacement for tippecanoe and
  tile-join. See below.
- **Raster overviews** (`src/utils/raster-pyramid.ts`), the replacement for
  `gdaladdo`: GDAL writes a BSB chart or a basemap at its native zoom only,
  and each lower zoom is built from the four tiles below it.
- **Archives** (`src/utils/tar-extract.ts`): `.tar`, `.tar.gz` and `.tar.xz`
  are read in JavaScript (xz through the WebAssembly decoder of
  `xz-decompress`), zip-slip-safe, links skipped.

## S-57: one pass for every band

An ENC bundle mixes IHO usage bands, from overview (band 1) to berthing
(band 6). Each band is meant to be seen at its own scales: a harbour plan's
detail clutters the overview zooms, and a coastal chart's coarse coastline
draws over the harbour plan at high zoom.

GDAL exports each cell's layers to `<LAYER>__<cell>.geojson`, one cell per
worker at a time. The export then becomes the tiler's sources, one per layer
and band, each shown at that band's zooms within the user's range
(`planTileSources`, `BAND_MIN_ZOOM` / `BAND_MAX_ZOOM` in `s57-band.ts`). The
tiler builds the whole bundle in one pass. 2.x ran one tippecanoe pass per band
and joined the results with tile-join; there is no join step now.

## The vector tiler

The tiler takes GeoJSON files, each with an output layer and a zoom range, and
writes an MBTiles. It is built so that every step runs on the workers and none
holds a whole bundle in memory.

1. **Bucket.** Workers read the GeoJSON files and sort each feature into the
   *shards* it reaches. A shard is the subtree of the tile pyramid under one
   tile at its source's minzoom; a feature goes into every shard its bounding
   box, plus the tile buffer, touches. Shards are line-delimited files on
   disk.
2. **Tile.** Each shard is self-contained, so the workers tile shards in
   parallel, largest first. A shard builds a
   [geojson-vt](https://github.com/mapbox/geojson-vt) index per source and
   walks its subtree depth-first, encoding a tile with
   [vt-pbf](https://github.com/mapbox/vt-pbf) wherever a source in range has
   features, and dropping visited tiles from the indexes as it goes.
3. **Merge.** Sources with different minzooms shard at different levels, so
   two shards can produce the same tile: adjacent bands share two zooms. When
   that can happen, tiles go to a scratch table first, and tiles with several
   parts have their same-named layers merged feature by feature. Otherwise
   tiles go straight into the MBTiles, compressed by the workers.

Two details make the shards cheap:

- **Re-rooting.** geojson-vt starts every index at the world tile, so a z12
  shard would clip and transform its features through twelve levels before
  reaching its own tile. Each shard instead rescales its coordinates so that
  its tile becomes the z3 tile (3, 3, 3). Scaling by a power of two keeps
  every tile boundary, so the tiles are the same, after three levels of work
  instead of twelve.
- **Exact pre-clipping.** Before re-rooting, each feature is clipped to the
  shard plus its buffer, which is exactly where geojson-vt would clip it at
  the shard's tile. Nothing then reaches the edge of the rescaled world, where
  geojson-vt would clamp latitudes or wrap copies across the antimeridian.

Geometry is kept as it is: no simplification, no dropped small polygons, no
feature or tile size limits, and a buffer of 80/256 of a tile — the settings
2.x gave tippecanoe so that harbour basins and narrow channels survive. List
attributes (`COLOUR`, `CATLIT`, …) are joined with commas and null attributes
dropped, as before. The MBTiles `json` metadata lists every layer with its
zoom range and attribute types.

On the 48-cell NOAA Rhode Island bundle (17 MB of S-57, z9-z16) the tiler
writes the same 24,380 tiles as the reference run without re-rooting, with the
same polygon coverage when sampled tile by tile, and matches GDAL's own MVT
writer to within edge quantization. GDAL export plus tiling takes about 25 s
on four cores.

## Raster charts and basemaps

A BSB/KAP chart is tiled by `gdal_translate -of MBTiles` (PNG tiles) at its
native zoom, then four overview zooms are added below it; a basemap
shapefile is rasterized to a world GeoTIFF, tiled, and given eight overview
zooms. The overview tiles are box-downsampled from the four tiles below,
like `gdaladdo -r average`, in the workers.

## Caches and versions

The chart-set cache keeps each cell's GeoJSON between runs, keyed by the
GDAL build that wrote it (`gdalBuildId()`, the pinned gdal3.js version). A
new gdal3.js version, or a cache written by 2.x's toolbox image, makes the
next update export its cells again. The ENC index builder
(`src/catalog/enc-index-cli.ts`) reads cells with the same GDAL.
