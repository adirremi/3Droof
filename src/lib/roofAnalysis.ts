import type { GridData, RoofAnalysisResult, RoofPlane } from '../types'

const SQ_M_PER_SQ_FT = 0.09290304
const FACET_COLORS = [
  '#38bdf8',
  '#22c55e',
  '#f97316',
  '#a78bfa',
  '#f43f5e',
  '#eab308',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
  '#fb7185',
]
const MIN_PLANE_AREA_SQ_FT = 60
const FLAT_PITCH_DEGREES = 5
const PITCH_MERGE_DEGREES = 8
const AZIMUTH_MERGE_DEGREES = 35
const HEIGHT_MERGE_METERS = 0.8

type SampleMetrics = {
  pitch: number
  azimuth: number
  areaSqFt: number
}

export function analyzeDsmRoof(grid: GridData, maskGrid?: GridData): RoofAnalysisResult {
  const cellCount = grid.width * grid.height
  const cellAreaSqFt = (grid.pixelSizeMeters * grid.pixelSizeMeters) / SQ_M_PER_SQ_FT

  const stats = computeMaskedHeightStats(grid, maskGrid)
  const heightRange = stats ? Math.max(stats.top - stats.base, 4) : 6
  const minHeight = stats ? stats.base - Math.max(1, heightRange * 0.25) : Number.NEGATIVE_INFINITY
  const maxHeight = stats ? stats.top + Math.max(2, heightRange * 0.5) : Number.POSITIVE_INFINITY

  const usable = new Uint8Array(cellCount)
  const pitchGrid = new Float32Array(cellCount)
  const azimuthGrid = new Float32Array(cellCount)
  const slopeAreaGrid = new Float32Array(cellCount)
  const heightGrid = new Float32Array(cellCount)
  for (let i = 0; i < cellCount; i += 1) {
    heightGrid[i] = Number.isFinite(grid.values[i]) ? grid.values[i] : Number.NaN
  }

  let validCells = 0
  let invalidCells = 0

  for (let y = 1; y < grid.height - 1; y += 1) {
    for (let x = 1; x < grid.width - 1; x += 1) {
      const idx = y * grid.width + x
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

      const center = heightGrid[idx]
      const left = heightGrid[idx - 1]
      const right = heightGrid[idx + 1]
      const top = heightGrid[idx - grid.width]
      const bottom = heightGrid[idx + grid.width]

      if (
        center < minHeight ||
        center > maxHeight ||
        Math.max(left, right, top, bottom) - Math.min(left, right, top, bottom) > 4
      ) {
        invalidCells += 1
        continue
      }

      const dzdx = (right - left) / (2 * grid.pixelSizeMeters)
      const dzdy = (bottom - top) / (2 * grid.pixelSizeMeters)
      const slope = Math.sqrt(dzdx ** 2 + dzdy ** 2)
      const pitch = radiansToDegrees(Math.atan(slope))

      if (pitch > 60) {
        invalidCells += 1
        continue
      }

      const azimuth = normalizeDegrees(radiansToDegrees(Math.atan2(dzdx, dzdy)))
      const slopeAreaSqFt = cellAreaSqFt * Math.sqrt(1 + slope ** 2)

      pitchGrid[idx] = pitch
      azimuthGrid[idx] = azimuth
      slopeAreaGrid[idx] = slopeAreaSqFt
      usable[idx] = 1
      validCells += 1
    }
  }

  const planeAssignments = new Int32Array(cellCount)
  planeAssignments.fill(-1)
  let nextClusterId = 0
  type ClusterAccumulator = {
    id: number
    cellCount: number
    areaSqFt: number
    sumPitchWeighted: number
    sumAzimuthSinWeighted: number
    sumAzimuthCosWeighted: number
    sumX: number
    sumY: number
    sumHeight: number
  }
  const clusters: ClusterAccumulator[] = []
  const queue = new Int32Array(cellCount)

  for (let startIdx = 0; startIdx < cellCount; startIdx += 1) {
    if (!usable[startIdx] || planeAssignments[startIdx] !== -1) continue

    let head = 0
    let tail = 0
    queue[tail++] = startIdx
    planeAssignments[startIdx] = nextClusterId
    const cluster: ClusterAccumulator = {
      id: nextClusterId,
      cellCount: 0,
      areaSqFt: 0,
      sumPitchWeighted: 0,
      sumAzimuthSinWeighted: 0,
      sumAzimuthCosWeighted: 0,
      sumX: 0,
      sumY: 0,
      sumHeight: 0,
    }

    while (head < tail) {
      const idx = queue[head++]
      const x = idx % grid.width
      const y = Math.floor(idx / grid.width)
      const area = slopeAreaGrid[idx]

      cluster.cellCount += 1
      cluster.areaSqFt += area
      cluster.sumPitchWeighted += pitchGrid[idx] * area
      const azimuthRadians = (azimuthGrid[idx] * Math.PI) / 180
      cluster.sumAzimuthSinWeighted += Math.sin(azimuthRadians) * area
      cluster.sumAzimuthCosWeighted += Math.cos(azimuthRadians) * area
      cluster.sumX += x
      cluster.sumY += y
      cluster.sumHeight += heightGrid[idx]

      const candidates: number[] = []
      if (x > 0) candidates.push(idx - 1)
      if (x < grid.width - 1) candidates.push(idx + 1)
      if (y > 0) candidates.push(idx - grid.width)
      if (y < grid.height - 1) candidates.push(idx + grid.width)

      for (const neighborIdx of candidates) {
        if (!usable[neighborIdx] || planeAssignments[neighborIdx] !== -1) continue
        if (!areCellsCompatible(idx, neighborIdx, pitchGrid, azimuthGrid, heightGrid)) continue

        planeAssignments[neighborIdx] = nextClusterId
        queue[tail++] = neighborIdx
      }
    }

    clusters.push(cluster)
    nextClusterId += 1
  }

  const baseZ = stats?.base ?? 0
  const scaleZ = heightRange < 6 ? 1.6 : heightRange < 14 ? 1.1 : 0.7
  const xOffset = (grid.width * grid.pixelSizeMeters) / 2
  const yOffset = (grid.height * grid.pixelSizeMeters) / 2

  const surviving = clusters
    .filter((cluster) => cluster.areaSqFt >= MIN_PLANE_AREA_SQ_FT)
    .sort((a, b) => b.areaSqFt - a.areaSqFt)

  const survivingIds = new Set(surviving.map((cluster) => cluster.id))
  for (let i = 0; i < cellCount; i += 1) {
    if (planeAssignments[i] !== -1 && !survivingIds.has(planeAssignments[i])) {
      planeAssignments[i] = -1
    }
  }

  const planes: RoofPlane[] = surviving.map((cluster, index) => {
    const avgPitch = cluster.sumPitchWeighted / Math.max(cluster.areaSqFt, 1)
    const azimuthRadians = Math.atan2(
      cluster.sumAzimuthSinWeighted / Math.max(cluster.areaSqFt, 1),
      cluster.sumAzimuthCosWeighted / Math.max(cluster.areaSqFt, 1),
    )
    const avgAzimuth = normalizeDegrees(radiansToDegrees(azimuthRadians))
    const avgX = cluster.sumX / cluster.cellCount
    const avgY = cluster.sumY / cluster.cellCount
    const avgHeight = cluster.sumHeight / cluster.cellCount

    const meshX = avgX * grid.pixelSizeMeters - xOffset
    const meshY = avgY * grid.pixelSizeMeters - yOffset
    const meshZ = Math.max(0, avgHeight - baseZ) * scaleZ

    return {
      id: `plane-${cluster.id}`,
      clusterId: cluster.id,
      letter: indexToLetter(index),
      label: `Facet ${indexToLetter(index)}`,
      color: FACET_COLORS[index % FACET_COLORS.length],
      cellCount: cluster.cellCount,
      areaSqFt: cluster.areaSqFt,
      pitchDegrees: avgPitch,
      azimuthDegrees: avgAzimuth,
      centroid: { x: meshX, y: meshY, z: meshZ },
    }
  })

  let totalAreaSqFt = 0
  let sumPitchWeighted = 0
  for (const plane of planes) {
    totalAreaSqFt += plane.areaSqFt
    sumPitchWeighted += plane.pitchDegrees * plane.areaSqFt
  }
  const averagePitchDegrees = totalAreaSqFt > 0 ? sumPitchWeighted / totalAreaSqFt : 0

  return {
    grid,
    maskGrid,
    planes,
    planeAssignments,
    meshSettings: { baseZ, scaleZ, xOffset, yOffset },
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

export function createMeshGeometry(grid: GridData, analysis?: RoofAnalysisResult) {
  const vertices: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const cellCount = grid.width * grid.height

  const settings = analysis?.meshSettings
  const baseZ = settings?.baseZ ?? 0
  const scaleZ = settings?.scaleZ ?? 1
  const xOffset = settings?.xOffset ?? (grid.width * grid.pixelSizeMeters) / 2
  const yOffset = settings?.yOffset ?? (grid.height * grid.pixelSizeMeters) / 2

  const assignments = analysis?.planeAssignments
  const clusterToColor = new Map<number, [number, number, number]>()
  if (analysis) {
    for (const plane of analysis.planes) {
      clusterToColor.set(plane.clusterId, hexToRgb(plane.color))
    }
  }

  const heights = new Float32Array(cellCount)
  for (let i = 0; i < cellCount; i += 1) {
    heights[i] = Number.isFinite(grid.values[i]) ? grid.values[i] : baseZ
  }

  const fallbackColor: [number, number, number] = [0.22, 0.74, 0.97]

  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const idx = y * grid.width + x
      const planeId = assignments ? assignments[idx] : -1
      const isInPlane = planeId !== -1
      const z = isInPlane ? Math.max(0, heights[idx] - baseZ) * scaleZ : 0
      vertices.push(
        x * grid.pixelSizeMeters - xOffset,
        y * grid.pixelSizeMeters - yOffset,
        z,
      )

      const color = isInPlane
        ? clusterToColor.get(planeId) ?? fallbackColor
        : fallbackColor
      colors.push(color[0], color[1], color[2])
    }
  }

  for (let y = 0; y < grid.height - 1; y += 1) {
    for (let x = 0; x < grid.width - 1; x += 1) {
      const a = y * grid.width + x
      const b = a + 1
      const c = a + grid.width
      const d = c + 1

      if (!assignments) continue

      const ida = assignments[a]
      const idb = assignments[b]
      const idc = assignments[c]
      const idd = assignments[d]

      if (ida === -1 || idb === -1 || idc === -1 || idd === -1) {
        continue
      }
      if (ida !== idb || ida !== idc || ida !== idd) {
        continue
      }

      indices.push(a, b, c, b, d, c)
    }
  }

  return {
    vertices,
    indices,
    colors,
  }
}

function areCellsCompatible(
  idxA: number,
  idxB: number,
  pitchGrid: Float32Array,
  azimuthGrid: Float32Array,
  heightGrid: Float32Array,
) {
  if (Math.abs(heightGrid[idxA] - heightGrid[idxB]) > HEIGHT_MERGE_METERS) {
    return false
  }

  const pitchA = pitchGrid[idxA]
  const pitchB = pitchGrid[idxB]
  if (Math.abs(pitchA - pitchB) > PITCH_MERGE_DEGREES) {
    return false
  }

  const flatBoth = pitchA < FLAT_PITCH_DEGREES && pitchB < FLAT_PITCH_DEGREES
  if (flatBoth) {
    return true
  }

  const azimuthDelta = Math.abs(azimuthGrid[idxA] - azimuthGrid[idxB])
  const wrappedDelta = Math.min(azimuthDelta, 360 - azimuthDelta)
  return wrappedDelta <= AZIMUTH_MERGE_DEGREES
}

function indexToLetter(index: number) {
  if (index < 26) {
    return String.fromCharCode(65 + index)
  }
  return `${String.fromCharCode(65 + Math.floor(index / 26) - 1)}${String.fromCharCode(65 + (index % 26))}`
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '')
  const value = parseInt(normalized, 16)
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}

function computeMaskedHeightStats(grid: GridData, maskGrid?: GridData) {
  const heights: number[] = []
  for (let index = 0; index < grid.values.length; index += 1) {
    const value = grid.values[index]
    if (!Number.isFinite(value)) continue
    if (maskGrid) {
      const maskValue = maskGrid.values[index]
      if (!Number.isFinite(maskValue) || maskValue <= 0) continue
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
  const complexityPenalty = Math.max(0, input.planes.length - 4) * 5
  let score = Math.round(validRatio * 65 + (largestPlaneRatio || 0) * 20 + (input.hasMask ? 15 : 5))
  score = Math.max(8, Math.min(96, score - complexityPenalty))

  const fallbackTriggers: string[] = []
  const reasons: string[] = []

  if (validRatio < 0.7) {
    fallbackTriggers.push('DSM has too many invalid or masked cells.')
    reasons.push('DSM coverage is incomplete.')
  }

  if (input.planes.length > 8) {
    fallbackTriggers.push('Roof has many small facets and may need paid measurement verification.')
    reasons.push('Geometry is complex.')
  }

  if (input.planes.length === 0) {
    fallbackTriggers.push('No facets were detected. Verify the address and Solar API coverage.')
    reasons.push('No roof facets detected.')
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
  const value = grid.values[y * grid.width + x]
  const mask = maskGrid ? maskGrid.values[y * maskGrid.width + x] : 1
  return (
    Number.isFinite(value) &&
    value !== grid.noDataValue &&
    Number.isFinite(mask) &&
    mask > 0
  )
}

function radiansToDegrees(radians: number) {
  return (radians * 180) / Math.PI
}

function normalizeDegrees(degrees: number) {
  return (degrees + 360) % 360
}

// Sample shape kept for backward-compatibility with previous callers (none active).
export type { SampleMetrics }
