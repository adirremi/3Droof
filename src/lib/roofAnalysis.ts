import type { GridData, RoofAnalysisResult, RoofPlane } from '../types'

const SQ_M_PER_SQ_FT = 0.09290304
const FACET_COLORS = ['#38bdf8', '#22c55e', '#f97316', '#a78bfa', '#f43f5e', '#eab308']
const MIN_PITCH_FOR_FACET_DEGREES = 5

type SlopeSample = {
  pitch: number
  azimuth: number
  areaSqFt: number
}

export function analyzeDsmRoof(grid: GridData, maskGrid?: GridData): RoofAnalysisResult {
  const samples: SlopeSample[] = []
  const cellAreaSqFt = (grid.pixelSizeMeters * grid.pixelSizeMeters) / SQ_M_PER_SQ_FT
  const stats = computeMaskedHeightStats(grid, maskGrid)
  const heightBuffer = stats ? Math.max(2, (stats.top - stats.base) * 0.4) : Number.POSITIVE_INFINITY
  const minHeight = stats ? stats.base - Math.max(1, heightBuffer * 0.5) : Number.NEGATIVE_INFINITY
  const maxHeight = stats ? stats.top + heightBuffer : Number.POSITIVE_INFINITY
  let validCells = 0
  let invalidCells = 0

  for (let y = 1; y < grid.height - 1; y += 1) {
    for (let x = 1; x < grid.width - 1; x += 1) {
      if (!isCellUsable(grid, x, y, maskGrid)) {
        invalidCells += 1
        continue
      }

      if (
        !isCellUsable(grid, x - 1, y, maskGrid) ||
        !isCellUsable(grid, x + 1, y, maskGrid) ||
        !isCellUsable(grid, x, y - 1, maskGrid) ||
        !isCellUsable(grid, x, y + 1, maskGrid)
      ) {
        invalidCells += 1
        continue
      }

      const center = getValue(grid, x, y)
      const left = getValue(grid, x - 1, y)
      const right = getValue(grid, x + 1, y)
      const top = getValue(grid, x, y - 1)
      const bottom = getValue(grid, x, y + 1)

      if (
        center < minHeight ||
        center > maxHeight ||
        Math.max(left, right, top, bottom) - Math.min(left, right, top, bottom) > 6
      ) {
        invalidCells += 1
        continue
      }

      const dzdx = (right - left) / (2 * grid.pixelSizeMeters)
      const dzdy = (bottom - top) / (2 * grid.pixelSizeMeters)
      const slope = Math.sqrt(dzdx ** 2 + dzdy ** 2)
      const pitch = radiansToDegrees(Math.atan(slope))

      if (pitch > 65) {
        invalidCells += 1
        continue
      }

      const azimuth = normalizeDegrees(radiansToDegrees(Math.atan2(dzdx, dzdy)))
      const slopeAreaSqFt = cellAreaSqFt * Math.sqrt(1 + slope ** 2)

      samples.push({ pitch, azimuth, areaSqFt: slopeAreaSqFt })
      validCells += 1
    }
  }

  const buckets = new Map<string, SlopeSample[]>()
  for (const sample of samples) {
    if (sample.pitch < MIN_PITCH_FOR_FACET_DEGREES) {
      continue
    }

    const pitchBucket = Math.round(sample.pitch / 4) * 4
    const azimuthBucket = Math.round(sample.azimuth / 45) * 45
    const key = `${pitchBucket}:${azimuthBucket}`
    buckets.set(key, [...(buckets.get(key) ?? []), sample])
  }

  const planes: RoofPlane[] = [...buckets.entries()]
    .map(([key, bucket], index) => {
      const [pitchBucket, azimuthBucket] = key.split(':').map(Number)
      const areaSqFt = bucket.reduce((sum, sample) => sum + sample.areaSqFt, 0)

      return {
        id: key,
        label: `Facet ${index + 1}`,
        color: FACET_COLORS[index % FACET_COLORS.length],
        cellCount: bucket.length,
        areaSqFt,
        pitchDegrees: weightedAverage(bucket, 'pitch') || pitchBucket,
        azimuthDegrees: weightedAverage(bucket, 'azimuth') || azimuthBucket,
      }
    })
    .filter((plane) => plane.areaSqFt > 12)
    .sort((a, b) => b.areaSqFt - a.areaSqFt)
    .slice(0, 8)

  const totalAreaSqFt = samples.reduce((sum, sample) => sum + sample.areaSqFt, 0)
  const averagePitchDegrees =
    samples.reduce((sum, sample) => sum + sample.pitch * sample.areaSqFt, 0) /
    Math.max(totalAreaSqFt, 1)

  return {
    grid,
    maskGrid,
    planes,
    totalAreaSqFt: Math.round(totalAreaSqFt),
    averagePitchDegrees,
    confidence: scoreConfidence({
      validCells,
      invalidCells,
      planes,
      averagePitchDegrees,
      hasMask: Boolean(maskGrid),
    }),
  }
}

export function createMeshGeometry(grid: GridData, maskGrid?: GridData) {
  const vertices: number[] = []
  const indices: number[] = []
  const xOffset = (grid.width * grid.pixelSizeMeters) / 2
  const yOffset = (grid.height * grid.pixelSizeMeters) / 2
  const stats = computeMaskedHeightStats(grid, maskGrid)
  const baseZ = stats?.base ?? 0
  const topZ = stats?.top ?? baseZ + 6
  const heightRange = Math.max(topZ - baseZ, 4)
  const lowerCutoff = baseZ - Math.max(1, heightRange * 0.25)
  const upperCutoff = topZ + Math.max(2, heightRange * 0.5)
  const scaleZ = heightRange < 6 ? 1.6 : heightRange < 14 ? 1.1 : 0.7
  const usable = new Uint8Array(grid.width * grid.height)
  const heights = new Float32Array(grid.width * grid.height)
  const interior = new Uint8Array(grid.width * grid.height)

  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const index = y * grid.width + x
      const rawValue = grid.values[index]
      const maskValue = maskGrid ? maskGrid.values[index] : 1
      const isMaskCell = Number.isFinite(maskValue) && maskValue > 0
      const isFiniteValue = Number.isFinite(rawValue)
      const inHeightWindow = isFiniteValue && rawValue >= lowerCutoff && rawValue <= upperCutoff
      usable[index] = isMaskCell && isFiniteValue && inHeightWindow ? 1 : 0
      heights[index] = isFiniteValue ? rawValue : baseZ
    }
  }

  for (let y = 1; y < grid.height - 1; y += 1) {
    for (let x = 1; x < grid.width - 1; x += 1) {
      const index = y * grid.width + x
      if (!usable[index]) {
        continue
      }

      const neighbors = [
        usable[index - 1],
        usable[index + 1],
        usable[index - grid.width],
        usable[index + grid.width],
      ]
      const neighborOk = neighbors.filter(Boolean).length
      interior[index] = neighborOk >= 3 ? 1 : 0
    }
  }

  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const index = y * grid.width + x
      const inside = interior[index]
      const z = inside ? Math.max(0, heights[index] - baseZ) * scaleZ : 0
      vertices.push(
        x * grid.pixelSizeMeters - xOffset,
        y * grid.pixelSizeMeters - yOffset,
        z,
      )
    }
  }

  for (let y = 0; y < grid.height - 1; y += 1) {
    for (let x = 0; x < grid.width - 1; x += 1) {
      const a = y * grid.width + x
      const b = a + 1
      const c = a + grid.width
      const d = c + 1

      const corners = [interior[a], interior[b], interior[c], interior[d]].filter(Boolean).length
      if (corners < 3) {
        continue
      }

      const maxHeight = Math.max(heights[a], heights[b], heights[c], heights[d])
      const minHeight = Math.min(heights[a], heights[b], heights[c], heights[d])
      if (maxHeight - minHeight > 4) {
        continue
      }

      indices.push(a, c, b, b, c, d)
    }
  }

  return {
    vertices,
    indices,
  }
}

function computeMaskedHeightStats(grid: GridData, maskGrid?: GridData) {
  const heights: number[] = []

  for (let index = 0; index < grid.values.length; index += 1) {
    const value = grid.values[index]
    if (!Number.isFinite(value)) {
      continue
    }

    if (maskGrid) {
      const maskValue = maskGrid.values[index]
      if (!Number.isFinite(maskValue) || maskValue <= 0) {
        continue
      }
    }

    heights.push(value)
  }

  if (heights.length === 0) {
    return undefined
  }

  heights.sort((a, b) => a - b)
  const baseIndex = Math.floor(heights.length * 0.03)
  const topIndex = Math.floor(heights.length * 0.97)
  return {
    base: heights[baseIndex],
    top: heights[Math.min(topIndex, heights.length - 1)],
  }
}

function scoreConfidence(input: {
  validCells: number
  invalidCells: number
  planes: RoofPlane[]
  averagePitchDegrees: number
  hasMask: boolean
}) {
  const totalCells = input.validCells + input.invalidCells
  const validRatio = totalCells > 0 ? input.validCells / totalCells : 0
  const largestPlaneRatio =
    input.planes[0]?.areaSqFt /
    Math.max(
      input.planes.reduce((sum, plane) => sum + plane.areaSqFt, 0),
      1,
    )
  const complexityPenalty = Math.max(0, input.planes.length - 4) * 7
  let score = Math.round(validRatio * 65 + (largestPlaneRatio || 0) * 20 + (input.hasMask ? 15 : 5))
  score = Math.max(8, Math.min(96, score - complexityPenalty))

  const fallbackTriggers: string[] = []
  const reasons: string[] = []

  if (validRatio < 0.72) {
    fallbackTriggers.push('DSM has too many invalid or masked cells.')
    reasons.push('DSM coverage is incomplete.')
  }

  if (input.planes.length > 6) {
    fallbackTriggers.push('Roof has many small facets and may need paid measurement verification.')
    reasons.push('Geometry is complex.')
  }

  if (input.averagePitchDegrees < 4 || input.averagePitchDegrees > 55) {
    fallbackTriggers.push('Pitch is outside normal residential range.')
    reasons.push('Pitch estimate needs review.')
  }

  if (!input.hasMask) {
    fallbackTriggers.push('No authoritative roof mask was available.')
    reasons.push('Analysis used elevation footprint only.')
  }

  if (fallbackTriggers.length === 0) {
    fallbackTriggers.push('No paid fallback needed unless this quote requires certified measurements.')
  }

  if (reasons.length === 0) {
    reasons.push('DSM coverage and plane grouping look stable for an automated estimate.')
  }

  return {
    level: score >= 78 ? 'high' : score >= 52 ? 'medium' : 'low',
    score,
    reasons,
    fallbackTriggers,
  } as const
}

function isCellUsable(grid: GridData, x: number, y: number, maskGrid?: GridData) {
  const value = getValue(grid, x, y)
  const mask = maskGrid ? getValue(maskGrid, x, y) : 1

  return (
    Number.isFinite(value) &&
    value !== grid.noDataValue &&
    Number.isFinite(mask) &&
    mask > 0
  )
}

function getValue(grid: GridData, x: number, y: number) {
  return grid.values[y * grid.width + x]
}

function weightedAverage(samples: SlopeSample[], field: 'pitch' | 'azimuth') {
  const totalArea = samples.reduce((sum, sample) => sum + sample.areaSqFt, 0)
  return samples.reduce((sum, sample) => sum + sample[field] * sample.areaSqFt, 0) / totalArea
}

function radiansToDegrees(radians: number) {
  return (radians * 180) / Math.PI
}

function normalizeDegrees(degrees: number) {
  return (degrees + 360) % 360
}
