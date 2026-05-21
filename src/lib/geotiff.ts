import { fromArrayBuffer } from 'geotiff'
import type { GridData } from '../types'

export async function readGeoTiffGrid(url: string, pixelSizeMeters?: number): Promise<GridData> {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Could not download GeoTIFF layer: ${response.status}`)
  }

  const buffer = await response.arrayBuffer()
  const tiff = await fromArrayBuffer(buffer)
  const image = await tiff.getImage()
  const width = image.getWidth()
  const height = image.getHeight()
  const raster = await image.readRasters({ interleave: true })
  const noDataValue = image.getGDALNoData()
  const resolution = image.getResolution()
  const modelPixelScale = (image.getFileDirectory() as { ModelPixelScale?: number[] })
    .ModelPixelScale
  const fallbackPixelSize =
    pixelSizeMeters ?? Math.abs(resolution?.[0] ?? modelPixelScale?.[0] ?? 0.1)
  const values = new Float32Array(width * height)

  for (let index = 0; index < values.length; index += 1) {
    const value = Number(raster[index])
    values[index] = value === noDataValue ? Number.NaN : value
  }

  return {
    width,
    height,
    values,
    noDataValue: noDataValue ?? undefined,
    pixelSizeMeters: fallbackPixelSize,
  }
}
