import type { GridData } from '../types'

export function createSampleRoofGrid(): GridData {
  const width = 52
  const height = 42
  const pixelSizeMeters = 0.45
  const values = new Float32Array(width * height)
  const centerX = width / 2
  const centerY = height / 2

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const normalizedX = Math.abs(x - centerX) / centerX
      const normalizedY = Math.abs(y - centerY) / centerY
      const footprint = normalizedX < 0.92 && normalizedY < 0.82

      if (!footprint) {
        values[y * width + x] = Number.NaN
        continue
      }

      const hipFalloff = Math.max(normalizedX * 1.05, normalizedY * 0.9)
      const ridgeBias = x > centerX ? 0.3 : -0.25
      const dormer = x > 31 && x < 40 && y > 12 && y < 23 ? 1.2 - normalizedY : 0
      const noise = Math.sin(x * 0.55) * 0.08 + Math.cos(y * 0.4) * 0.06

      values[y * width + x] = 9.8 - hipFalloff * 4.8 + ridgeBias + dormer + noise
    }
  }

  return {
    width,
    height,
    pixelSizeMeters,
    values,
  }
}
