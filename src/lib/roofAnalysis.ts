import type {
  GridData,
  LatLng,
  RoofAnalysisResult,
  RoofPlane,
  RoofSegmentStats,
} from '../types'

const SQ_M_PER_SQ_FT = 0.09290304
const METERS_PER_DEGREE_LAT = 111_320
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
  '#0ea5e9',
  '#4ade80',
]
const MIN_PLANE_CELLS = 6
const FALLBACK_COLOR: [number, number, number] = [0.22, 0.74, 0.97]

type AnalyzeOptions = {
  place?: LatLng
  roofSegments?: RoofSegmentStats[]
}

export function analyzeDsmRoof(
  grid: GridData,
  maskGrid?: GridData,
  options?: AnalyzeOptions,
): RoofAnalysisResult {
  const stats = computeMaskedHeightStats(grid, maskGrid)
  const heightRange = stats ? Math.max(stats.top - stats.base, 4) : 6
  const baseZ = stats?.base ?? 0
  const scaleZ = heightRange < 6 ? 1.6 : heightRange < 14 ? 1.1 : 0.7
  const xOffset = (grid.width * grid.pixelSizeMeters) / 2
  const yOffset = (grid.height * grid.pixelSizeMeters) / 2

  const usableSegments = (options?.roofSegments ?? []).filter(
    (segment): segment is RoofSegmentStats & { center: LatLng } => Boolean(segment.center),
  )

  if (usableSegments.length > 0 && options?.place) {
    return analyzeWithSegments(grid, maskGrid, options.place, usableSegments, {
      baseZ,
      scaleZ,
      xOffset,
      yOffset,
      stats,
    })
  }

  return analyzeWithFallbackClustering(grid, maskGrid, {
    baseZ,
    scaleZ,
    xOffset,
    yOffset,
    stats,
  })
}

type MeshGeometryParams = {
  baseZ: number
  scaleZ: number
  xOffset: number
  yOffset: number
  stats?: { base: number; top: number }
}

function analyzeWithSegments(
  grid: GridData,
  maskGrid: GridData | undefined,
  place: LatLng,
  segments: RoofSegmentStats[],
  mesh: MeshGeometryParams,
): RoofAnalysisResult {
  const cellCount = grid.width * grid.height
  const heights = extractHeights(grid)
  const pixelSize = grid.pixelSizeMeters
  const metersPerLng = metersPerDegLng(place.lat)

  const segmentMeta = segments.map((segment, index) => {
    const center = segment.center!
    const cxMeters = (center.lng - place.lng) * metersPerLng
    const cyMeters = -(center.lat - place.lat) * METERS_PER_DEGREE_LAT
    const planeHeight = segment.planeHeightAtCenterMeters ?? 0
    const pitch = segment.pitchDegrees ?? 0
    const az = segment.azimuthDegrees ?? 0
    const pitchRad = (pitch * Math.PI) / 180
    const azRad = (az * Math.PI) / 180
    const sinP = Math.sin(pitchRad)
    const cosP = Math.cos(pitchRad)
    return {
      index,
      segment,
      pitch,
      az,
      cxMeters,
      cyMeters,
      cz: planeHeight,
      nx: sinP * Math.sin(azRad),
      ny: -sinP * Math.cos(azRad),
      nz: cosP,
      isFlat: pitch < 5,
      area: segment.stats?.areaMeters2 ?? 0,
    }
  })

  // Hard tolerance: how far a DSM cell may sit from a Solar plane to still count as on it.
  // Solar Building Insights resolves to ~0.3 m vertical accuracy; DSM noise is ~0.5 m.
  const PLANE_DISTANCE_TOLERANCE = 1.2
  // Light spatial weighting only matters when two planes fit the cell equally well.
  const SPATIAL_WEIGHT = 0.04

  const planeAssignments = new Int32Array(cellCount)
  planeAssignments.fill(-1)
  let validCells = 0
  let invalidCells = 0
  const halfWidthMeters = (grid.width * pixelSize) / 2
  const halfHeightMeters = (grid.height * pixelSize) / 2

  for (let y = 0; y < grid.height; y += 1) {
    const qy = y * pixelSize - halfHeightMeters
    for (let x = 0; x < grid.width; x += 1) {
      const idx = y * grid.width + x
      const value = grid.values[idx]
      const maskValue = maskGrid ? maskGrid.values[idx] : 1
      const inMask =
        Number.isFinite(value) &&
        value !== grid.noDataValue &&
        Number.isFinite(maskValue) &&
        maskValue > 0

      if (!inMask) {
        invalidCells += 1
        continue
      }

      const qx = x * pixelSize - halfWidthMeters
      const qz = heights[idx]

      let bestScore = Number.POSITIVE_INFINITY
      let bestIndex = -1

      for (const seg of segmentMeta) {
        const dx = qx - seg.cxMeters
        const dy = qy - seg.cyMeters
        const dz = qz - seg.cz
        const planeDistance = Math.abs(seg.nx * dx + seg.ny * dy + seg.nz * dz)
        if (planeDistance > PLANE_DISTANCE_TOLERANCE) continue

        const spatial = Math.sqrt(dx * dx + dy * dy)
        const score = planeDistance + spatial * SPATIAL_WEIGHT

        if (score < bestScore) {
          bestScore = score
          bestIndex = seg.index
        }
      }

      planeAssignments[idx] = bestIndex
      if (bestIndex !== -1) {
        validCells += 1
      }
    }
  }

  smoothAssignments(planeAssignments, grid.width, grid.height, 1)

  const accumulators = segments.map(() => ({
    cellCount: 0,
    sumX: 0,
    sumY: 0,
    sumHeight: 0,
  }))

  for (let i = 0; i < cellCount; i += 1) {
    const segmentIndex = planeAssignments[i]
    if (segmentIndex === -1) continue
    const x = i % grid.width
    const y = Math.floor(i / grid.width)
    accumulators[segmentIndex].cellCount += 1
    accumulators[segmentIndex].sumX += x
    accumulators[segmentIndex].sumY += y
    accumulators[segmentIndex].sumHeight += heights[i]
  }

  const planesUnsorted = segments
    .map((segment, segmentIndex) => {
      const accumulator = accumulators[segmentIndex]
      if (accumulator.cellCount < MIN_PLANE_CELLS) return undefined
      const areaSqFt = (segment.stats?.areaMeters2 ?? 0) / SQ_M_PER_SQ_FT
      const meshX = (accumulator.sumX / accumulator.cellCount) * grid.pixelSizeMeters - mesh.xOffset
      const meshY = (accumulator.sumY / accumulator.cellCount) * grid.pixelSizeMeters - mesh.yOffset
      const meshZ = Math.max(
        0,
        (accumulator.sumHeight / accumulator.cellCount) - mesh.baseZ,
      ) * mesh.scaleZ
      return {
        segmentIndex,
        plane: {
          areaSqFt,
          pitchDegrees: segment.pitchDegrees ?? 0,
          azimuthDegrees: segment.azimuthDegrees ?? 0,
          cellCount: accumulator.cellCount,
          centroid: { x: meshX, y: meshY, z: meshZ },
        },
      }
    })
    .filter((entry): entry is Exclude<typeof entry, undefined> => Boolean(entry))

  planesUnsorted.sort((a, b) => b.plane.areaSqFt - a.plane.areaSqFt)

  const remap = new Map<number, number>()
  planesUnsorted.forEach((entry, displayIndex) => {
    remap.set(entry.segmentIndex, displayIndex)
  })

  for (let i = 0; i < cellCount; i += 1) {
    const original = planeAssignments[i]
    if (original === -1) continue
    const remapped = remap.get(original)
    planeAssignments[i] = remapped !== undefined ? remapped : -1
  }

  const planes: RoofPlane[] = planesUnsorted.map((entry, displayIndex) => {
    const letter = indexToLetter(displayIndex)
    return {
      id: `seg-${entry.segmentIndex}`,
      clusterId: displayIndex,
      label: `Facet ${letter}`,
      letter,
      color: FACET_COLORS[displayIndex % FACET_COLORS.length],
      cellCount: entry.plane.cellCount,
      areaSqFt: entry.plane.areaSqFt,
      pitchDegrees: entry.plane.pitchDegrees,
      azimuthDegrees: entry.plane.azimuthDegrees,
      centroid: entry.plane.centroid,
    }
  })

  const totalAreaSqFt = planes.reduce((sum, plane) => sum + plane.areaSqFt, 0)
  const averagePitchDegrees =
    totalAreaSqFt > 0
      ? planes.reduce((sum, plane) => sum + plane.pitchDegrees * plane.areaSqFt, 0) / totalAreaSqFt
      : 0

  return {
    grid,
    maskGrid,
    planes,
    planeAssignments,
    meshSettings: {
      baseZ: mesh.baseZ,
      scaleZ: mesh.scaleZ,
      xOffset: mesh.xOffset,
      yOffset: mesh.yOffset,
    },
    totalAreaSqFt: Math.round(totalAreaSqFt),
    averagePitchDegrees,
    confidence: scoreConfidence({
      validCells,
      invalidCells,
      planes,
      averagePitchDegrees,
      hasMask: Boolean(maskGrid),
      usingSegments: true,
    }),
  }
}

function analyzeWithFallbackClustering(
  grid: GridData,
  maskGrid: GridData | undefined,
  mesh: MeshGeometryParams,
): RoofAnalysisResult {
  const cellCount = grid.width * grid.height
  const planeAssignments = new Int32Array(cellCount)
  planeAssignments.fill(-1)

  return {
    grid,
    maskGrid,
    planes: [],
    planeAssignments,
    meshSettings: {
      baseZ: mesh.baseZ,
      scaleZ: mesh.scaleZ,
      xOffset: mesh.xOffset,
      yOffset: mesh.yOffset,
    },
    totalAreaSqFt: 0,
    averagePitchDegrees: 0,
    confidence: scoreConfidence({
      validCells: 0,
      invalidCells: cellCount,
      planes: [],
      averagePitchDegrees: 0,
      hasMask: Boolean(maskGrid),
      usingSegments: false,
    }),
  }
}

function smoothAssignments(
  assignments: Int32Array,
  width: number,
  height: number,
  iterations = 2,
) {
  const buffer = new Int32Array(assignments.length)
  for (let pass = 0; pass < iterations; pass += 1) {
    buffer.set(assignments)
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const idx = y * width + x
        const me = assignments[idx]
        if (me === -1) continue
        const tally = new Map<number, number>()
        const neighbors = [
          assignments[idx - 1],
          assignments[idx + 1],
          assignments[idx - width],
          assignments[idx + width],
        ]
        for (const neighbor of neighbors) {
          if (neighbor === -1) continue
          tally.set(neighbor, (tally.get(neighbor) ?? 0) + 1)
        }
        let bestNeighbor = me
        let bestCount = tally.get(me) ?? 0
        for (const [id, count] of tally) {
          if (count > bestCount) {
            bestCount = count
            bestNeighbor = id
          }
        }
        if (bestCount >= 3 && bestNeighbor !== me) {
          buffer[idx] = bestNeighbor
        }
      }
    }
    assignments.set(buffer)
  }
}

export function createMeshGeometry(grid: GridData, analysis?: RoofAnalysisResult) {
  const vertices: number[] = []
  const colors: number[] = []
  const indices: number[] = []

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

  const heights = extractHeights(grid, baseZ)

  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const idx = y * grid.width + x
      const planeId = assignments ? assignments[idx] : -1
      const inPlane = planeId !== -1
      const z = inPlane ? Math.max(0, heights[idx] - baseZ) * scaleZ : 0
      vertices.push(
        x * grid.pixelSizeMeters - xOffset,
        y * grid.pixelSizeMeters - yOffset,
        z,
      )
      const color = inPlane ? clusterToColor.get(planeId) ?? FALLBACK_COLOR : FALLBACK_COLOR
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

      const minHeight = Math.min(heights[a], heights[b], heights[c], heights[d])
      const maxHeight = Math.max(heights[a], heights[b], heights[c], heights[d])
      if (maxHeight - minHeight > 6) {
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

function extractHeights(grid: GridData, fallback = 0) {
  const heights = new Float32Array(grid.values.length)
  for (let i = 0; i < grid.values.length; i += 1) {
    heights[i] = Number.isFinite(grid.values[i]) ? grid.values[i] : fallback
  }
  return heights
}

function metersPerDegLng(lat: number) {
  return METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180)
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
  usingSegments: boolean
}) {
  const totalCells = input.validCells + input.invalidCells
  const validRatio = totalCells > 0 ? input.validCells / totalCells : 0
  const largestPlaneRatio =
    input.planes[0]?.areaSqFt /
    Math.max(
      input.planes.reduce((sum, plane) => sum + plane.areaSqFt, 0),
      1,
    )
  const complexityPenalty = Math.max(0, input.planes.length - 6) * 4
  let score = Math.round(
    validRatio * 55 +
      (largestPlaneRatio || 0) * 15 +
      (input.hasMask ? 15 : 5) +
      (input.usingSegments ? 15 : 0),
  )
  score = Math.max(10, Math.min(98, score - complexityPenalty))

  const fallbackTriggers: string[] = []
  const reasons: string[] = []

  if (!input.usingSegments) {
    fallbackTriggers.push('Solar API roof segments were not available. Coverage may be limited.')
    reasons.push('Solar API did not return roof segments.')
  }

  if (validRatio < 0.6) {
    fallbackTriggers.push('DSM has too many invalid or masked cells.')
    reasons.push('DSM coverage is incomplete.')
  }

  if (input.planes.length === 0) {
    fallbackTriggers.push('No roof facets were detected. Verify the address.')
    reasons.push('No facets detected for this property.')
  }

  if (input.planes.length > 10) {
    reasons.push('Roof has many facets — verify by hand if measurements are critical.')
  }

  if (!input.hasMask) {
    fallbackTriggers.push('No authoritative roof mask was available.')
    reasons.push('Analysis used elevation footprint only.')
  }

  if (fallbackTriggers.length === 0) {
    fallbackTriggers.push('No paid fallback needed unless this quote requires certified measurements.')
  }

  if (reasons.length === 0) {
    reasons.push('Solar segments matched DSM cleanly; estimates should be reliable.')
  }

  return {
    level: score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low',
    score,
    reasons,
    fallbackTriggers,
  } as const
}

function indexToLetter(index: number) {
  if (index < 26) {
    return String.fromCharCode(65 + index)
  }
  return `${String.fromCharCode(65 + Math.floor(index / 26) - 1)}${String.fromCharCode(
    65 + (index % 26),
  )}`
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '')
  const value = parseInt(normalized, 16)
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}
