import type {
  GridData,
  LatLng,
  Point2D,
  Point3D,
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
  const baseZ = stats?.base ?? 0
  // True 1:1 vertical scale so the rendered pitch matches the real roof geometry.
  const scaleZ = 1
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

  const SOFT_TOLERANCE = 1.6
  const SPATIAL_WEIGHT = 0.04

  const planeAssignments = new Int32Array(cellCount)
  planeAssignments.fill(-1)
  const maskCells = new Uint8Array(cellCount)
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

      maskCells[idx] = 1
      const qx = x * pixelSize - halfWidthMeters
      const qz = heights[idx]

      let bestScore = Number.POSITIVE_INFINITY
      let bestIndex = -1
      let bestPlaneDistance = Number.POSITIVE_INFINITY

      for (const seg of segmentMeta) {
        const dx = qx - seg.cxMeters
        const dy = qy - seg.cyMeters
        const dz = qz - seg.cz
        const planeDistance = Math.abs(seg.nx * dx + seg.ny * dy + seg.nz * dz)
        const spatial = Math.sqrt(dx * dx + dy * dy)
        const score = planeDistance + spatial * SPATIAL_WEIGHT

        if (score < bestScore) {
          bestScore = score
          bestIndex = seg.index
          bestPlaneDistance = planeDistance
        }
      }

      if (bestIndex !== -1 && bestPlaneDistance <= SOFT_TOLERANCE) {
        planeAssignments[idx] = bestIndex
        validCells += 1
      }
    }
  }

  // Fill in remaining mask cells using nearest assigned neighbor (propagation).
  fillMaskGapsByPropagation(planeAssignments, maskCells, grid.width, grid.height)

  // Aggressive smoothing for clean facet boundaries.
  smoothAssignments(planeAssignments, grid.width, grid.height, 4)
  morphologicalClose(planeAssignments, maskCells, grid.width, grid.height)

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
      const groundAreaSqFt = (segment.stats?.groundAreaMeters2 ?? 0) / SQ_M_PER_SQ_FT
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
          groundAreaSqFt,
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
    const meta = segmentMeta[entry.segmentIndex]
    return {
      id: `seg-${entry.segmentIndex}`,
      clusterId: displayIndex,
      label: `Facet ${letter}`,
      letter,
      color: FACET_COLORS[displayIndex % FACET_COLORS.length],
      cellCount: entry.plane.cellCount,
      areaSqFt: entry.plane.areaSqFt,
      groundAreaSqFt: entry.plane.groundAreaSqFt,
      pitchDegrees: entry.plane.pitchDegrees,
      azimuthDegrees: entry.plane.azimuthDegrees,
      centroid: entry.plane.centroid,
      planeEquation: {
        cxMeters: meta.cxMeters,
        cyMeters: meta.cyMeters,
        cz: meta.cz,
        nx: meta.nx,
        ny: meta.ny,
        nz: meta.nz,
      },
    }
  })

  // Capture cells per plane after final assignment so we can render clean polygons.
  const cellsByPlane: Int32Array[] = planes.map(() => new Int32Array(0))
  const cellLists: number[][] = planes.map(() => [])
  for (let i = 0; i < cellCount; i += 1) {
    const planeIdx = planeAssignments[i]
    if (planeIdx === -1) continue
    cellLists[planeIdx]?.push(i)
  }
  for (let i = 0; i < planes.length; i += 1) {
    cellsByPlane[i] = new Int32Array(cellLists[i])
  }

  // Single dominant orientation for the whole building so shared edges align across facets.
  const globalOrientationRad = computeGlobalOrientation(planes)

  // Compute clean polygon per facet using boundary tracing + Douglas-Peucker + orientation snapping.
  for (let i = 0; i < planes.length; i += 1) {
    const plane = planes[i]
    const cells = cellsByPlane[i]
    if (!plane.planeEquation || cells.length < MIN_PLANE_CELLS) continue
    const polygon3D = buildFacetPolygon3D({
      cells,
      gridWidth: grid.width,
      gridHeight: grid.height,
      pixelSize,
      xOffset: mesh.xOffset,
      yOffset: mesh.yOffset,
      orientationRad: globalOrientationRad,
      planeEq: plane.planeEquation,
      // Anchor the facet to its real measured DSM height, then tilt it with the precise
      // Solar pitch/azimuth gradient. This avoids datum mismatches that flattened the model.
      anchorZ: plane.centroid.z,
      centerX: plane.centroid.x,
      centerY: plane.centroid.y,
      scaleZ: mesh.scaleZ,
    })
    if (polygon3D.length >= 3) {
      plane.polygon3D = polygon3D
      const cz = polygon3D.reduce((sum, p) => sum + p.z, 0) / polygon3D.length
      const cxMesh = polygon3D.reduce((sum, p) => sum + p.x, 0) / polygon3D.length
      const cyMesh = polygon3D.reduce((sum, p) => sum + p.y, 0) / polygon3D.length
      plane.centroid = { x: cxMesh, y: cyMesh, z: cz }
    }
  }

  const totalAreaSqFt = planes.reduce((sum, plane) => sum + plane.areaSqFt, 0)
  const totalGroundAreaSqFt = planes.reduce((sum, plane) => sum + plane.groundAreaSqFt, 0)
  const averagePitchDegrees =
    totalAreaSqFt > 0
      ? planes.reduce((sum, plane) => sum + plane.pitchDegrees * plane.areaSqFt, 0) / totalAreaSqFt
      : 0

  return {
    grid,
    maskGrid,
    planes,
    planeAssignments,
    cellsByPlane,
    meshSettings: {
      baseZ: mesh.baseZ,
      scaleZ: mesh.scaleZ,
      xOffset: mesh.xOffset,
      yOffset: mesh.yOffset,
    },
    totalAreaSqFt: Math.round(totalAreaSqFt),
    totalGroundAreaSqFt: Math.round(totalGroundAreaSqFt),
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

// Area-weighted dominant orientation, folded to a 90° period (roofs are mostly rectilinear).
function computeGlobalOrientation(planes: RoofPlane[]): number {
  let sumSin = 0
  let sumCos = 0
  for (const plane of planes) {
    const weight = Math.max(plane.areaSqFt, 1)
    // Azimuth is the down-slope compass bearing; the eave/ridge runs perpendicular to it.
    // Fold to [0, 90) and multiply by 4 so the circular mean respects the 90° symmetry.
    const foldedRad = (((plane.azimuthDegrees % 90) + 90) % 90) * (Math.PI / 180) * 4
    sumSin += weight * Math.sin(foldedRad)
    sumCos += weight * Math.cos(foldedRad)
  }
  if (sumSin === 0 && sumCos === 0) return 0
  return Math.atan2(sumSin, sumCos) / 4
}

function fillMaskGapsByPropagation(
  assignments: Int32Array,
  mask: Uint8Array,
  width: number,
  height: number,
) {
  const queue: number[] = []
  for (let i = 0; i < assignments.length; i += 1) {
    if (mask[i] && assignments[i] === -1) queue.push(i)
  }
  let safety = 0
  while (queue.length > 0 && safety < 10) {
    safety += 1
    const nextRound: number[] = []
    for (const idx of queue) {
      if (assignments[idx] !== -1) continue
      const x = idx % width
      const y = Math.floor(idx / width)
      const tally = new Map<number, number>()
      if (x > 0) addToTally(tally, assignments[idx - 1])
      if (x < width - 1) addToTally(tally, assignments[idx + 1])
      if (y > 0) addToTally(tally, assignments[idx - width])
      if (y < height - 1) addToTally(tally, assignments[idx + width])
      let bestValue = -1
      let bestCount = 0
      for (const [value, count] of tally) {
        if (count > bestCount) {
          bestCount = count
          bestValue = value
        }
      }
      if (bestValue !== -1) {
        assignments[idx] = bestValue
      } else {
        nextRound.push(idx)
      }
    }
    if (nextRound.length === queue.length) break
    queue.length = 0
    queue.push(...nextRound)
  }
}

function addToTally(tally: Map<number, number>, value: number) {
  if (value === -1) return
  tally.set(value, (tally.get(value) ?? 0) + 1)
}

function morphologicalClose(
  assignments: Int32Array,
  mask: Uint8Array,
  width: number,
  height: number,
) {
  const buffer = new Int32Array(assignments.length)
  for (let pass = 0; pass < 2; pass += 1) {
    buffer.set(assignments)
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const idx = y * width + x
        if (!mask[idx] || assignments[idx] === -1) continue
        const me = assignments[idx]
        const neighbors = [
          assignments[idx - 1],
          assignments[idx + 1],
          assignments[idx - width],
          assignments[idx + width],
        ]
        const tally = new Map<number, number>()
        for (const value of neighbors) {
          if (value === -1) continue
          tally.set(value, (tally.get(value) ?? 0) + 1)
        }
        let bestValue = me
        let bestCount = tally.get(me) ?? 0
        for (const [value, count] of tally) {
          if (count > bestCount) {
            bestCount = count
            bestValue = value
          }
        }
        if (bestCount >= 3 && bestValue !== me) {
          buffer[idx] = bestValue
        }
      }
    }
    assignments.set(buffer)
  }
}

type BuildPolygonArgs = {
  cells: Int32Array
  gridWidth: number
  gridHeight: number
  pixelSize: number
  xOffset: number
  yOffset: number
  orientationRad: number
  planeEq: NonNullable<RoofPlane['planeEquation']>
  anchorZ: number
  centerX: number
  centerY: number
  scaleZ: number
}

function buildFacetPolygon3D(args: BuildPolygonArgs): Point3D[] {
  const {
    cells,
    gridWidth,
    gridHeight,
    pixelSize,
    xOffset,
    yOffset,
    orientationRad,
    planeEq,
    anchorZ,
    centerX,
    centerY,
    scaleZ,
  } = args

  if (cells.length < 4) return []

  const cellSet = new Set<number>()
  for (let i = 0; i < cells.length; i += 1) cellSet.add(cells[i])

  // Trace the true outer outline along pixel edges (handles concave L/T facets correctly).
  const cornerLoop = traceCellOutline(cellSet, gridWidth, gridHeight)
  if (cornerLoop.length < 3) return []

  // Cell (x,y) center sits at x*pixelSize; its corners are at (x±0.5). Shift corner coords accordingly.
  const boundary: Point2D[] = cornerLoop.map((corner) => ({
    x: (corner.x - 0.5) * pixelSize - xOffset,
    y: (corner.y - 0.5) * pixelSize - yOffset,
  }))

  // Simplify the rectilinear staircase into a few straight edges.
  const epsilon = pixelSize * 1.4
  let simplified = douglasPeuckerClosed(boundary, epsilon)
  if (simplified.length < 3) return []

  // Snap edges to the single building orientation so adjacent facets share aligned ridges/eaves.
  simplified = snapEdgesToOrientation(simplified, orientationRad)
  simplified = mergeColinear(simplified, Math.PI / 30, pixelSize * 0.6)
  if (simplified.length < 3) return []

  // Slope gradient (rise per horizontal metre) straight from the Solar pitch/azimuth normal.
  const gradX = -planeEq.nx / (planeEq.nz || 1)
  const gradY = -planeEq.ny / (planeEq.nz || 1)

  // Tilt the facet around its measured anchor height using the exact Solar gradient.
  const result: Point3D[] = simplified.map((p) => {
    const rise = (gradX * (p.x - centerX) + gradY * (p.y - centerY)) * scaleZ
    return { x: p.x, y: p.y, z: Math.max(0, anchorZ + rise) }
  })

  return result
}

// Walk the outer pixel-edge contour of a connected cell set, returning ordered corner coordinates.
function traceCellOutline(
  cellSet: Set<number>,
  gridWidth: number,
  gridHeight: number,
): Point2D[] {
  const inSet = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) return false
    return cellSet.has(y * gridWidth + x)
  }

  // Directed boundary edges with the foreground on the right => consistent clockwise winding.
  // Key a corner by cornerX * STRIDE + cornerY (corner coords range 0..gridWidth/Height).
  const STRIDE = gridHeight + 2
  const cornerKey = (x: number, y: number) => x * STRIDE + y
  const edgesFrom = new Map<number, Point2D[]>()
  const addEdge = (ax: number, ay: number, bx: number, by: number) => {
    const k = cornerKey(ax, ay)
    const list = edgesFrom.get(k)
    const end = { x: bx, y: by }
    if (list) list.push(end)
    else edgesFrom.set(k, [end])
  }

  for (const idx of cellSet) {
    const x = idx % gridWidth
    const y = Math.floor(idx / gridWidth)
    if (!inSet(x, y - 1)) addEdge(x, y, x + 1, y)
    if (!inSet(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1)
    if (!inSet(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1)
    if (!inSet(x - 1, y)) addEdge(x, y + 1, x, y)
  }

  if (edgesFrom.size === 0) return []

  // Find the lexicographically smallest corner that starts an edge as the loop seed.
  let startKey = Number.POSITIVE_INFINITY
  let startCorner: Point2D | undefined
  for (const [k, ends] of edgesFrom) {
    if (ends.length === 0) continue
    if (k < startKey) {
      startKey = k
      startCorner = { x: Math.floor(k / STRIDE), y: k % STRIDE }
    }
  }
  if (!startCorner) return []

  const loop: Point2D[] = []
  let current = startCorner
  const maxSteps = edgesFrom.size * 4 + 8
  for (let step = 0; step < maxSteps; step += 1) {
    const k = cornerKey(current.x, current.y)
    const ends = edgesFrom.get(k)
    if (!ends || ends.length === 0) break
    const next = ends.shift()!
    loop.push(current)
    if (next.x === startCorner.x && next.y === startCorner.y) break
    current = next
  }

  return loop.length >= 3 ? loop : []
}

function douglasPeuckerClosed(points: Point2D[], epsilon: number): Point2D[] {
  if (points.length < 4) return points

  // Choose two extreme anchors (leftmost and rightmost) as the starting split.
  let leftIdx = 0
  let rightIdx = 0
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].x < points[leftIdx].x) leftIdx = i
    if (points[i].x > points[rightIdx].x) rightIdx = i
  }
  if (leftIdx === rightIdx) return points

  const keep = new Uint8Array(points.length)
  keep[leftIdx] = 1
  keep[rightIdx] = 1

  const simplifyRange = (startIdx: number, endIdx: number) => {
    // Walk from startIdx (exclusive) to endIdx (exclusive) along the polygon ring.
    const start = points[startIdx]
    const end = points[endIdx]
    let maxDist = 0
    let maxIdx = -1
    let i = (startIdx + 1) % points.length
    while (i !== endIdx) {
      const d = perpDistance(points[i], start, end)
      if (d > maxDist) {
        maxDist = d
        maxIdx = i
      }
      i = (i + 1) % points.length
    }
    if (maxDist > epsilon && maxIdx !== -1) {
      keep[maxIdx] = 1
      simplifyRange(startIdx, maxIdx)
      simplifyRange(maxIdx, endIdx)
    }
  }

  simplifyRange(leftIdx, rightIdx)
  simplifyRange(rightIdx, leftIdx)

  const result: Point2D[] = []
  for (let i = 0; i < points.length; i += 1) {
    if (keep[i]) result.push(points[i])
  }
  return result
}

function perpDistance(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-9) {
    const ex = p.x - a.x
    const ey = p.y - a.y
    return Math.sqrt(ex * ex + ey * ey)
  }
  const num = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x)
  return num / Math.sqrt(len2)
}

function snapEdgesToOrientation(polygon: Point2D[], orientationRad: number): Point2D[] {
  if (polygon.length < 3) return polygon
  // Two orthogonal building axes shared by every facet on the roof.
  const axisA = { x: Math.cos(orientationRad), y: Math.sin(orientationRad) }
  const axisB = { x: -Math.sin(orientationRad), y: Math.cos(orientationRad) }
  const slope = axisA
  const perp = axisB

  const SNAP_TOL_DEG = 22
  const snapCos = Math.cos((SNAP_TOL_DEG * Math.PI) / 180)

  // Iterative snap (multiple passes converge as endpoints get shared).
  const result: Point2D[] = polygon.map((p) => ({ x: p.x, y: p.y }))
  for (let pass = 0; pass < 3; pass += 1) {
    for (let i = 0; i < result.length; i += 1) {
      const a = result[i]
      const b = result[(i + 1) % result.length]
      const ex = b.x - a.x
      const ey = b.y - a.y
      const elen = Math.sqrt(ex * ex + ey * ey)
      if (elen < 1e-3) continue
      const ux = ex / elen
      const uy = ey / elen

      const dotSlope = Math.abs(ux * slope.x + uy * slope.y)
      const dotPerp = Math.abs(ux * perp.x + uy * perp.y)
      let target: Point2D | undefined
      if (dotPerp > snapCos && dotPerp >= dotSlope) target = perp
      else if (dotSlope > snapCos) target = slope
      if (!target) continue

      const sign = ux * target.x + uy * target.y >= 0 ? 1 : -1
      const midX = (a.x + b.x) / 2
      const midY = (a.y + b.y) / 2
      const half = elen / 2
      result[i] = { x: midX - sign * half * target.x, y: midY - sign * half * target.y }
      result[(i + 1) % result.length] = {
        x: midX + sign * half * target.x,
        y: midY + sign * half * target.y,
      }
    }
  }
  return result
}

function mergeColinear(polygon: Point2D[], angleTolRad: number, minEdgeMeters: number): Point2D[] {
  if (polygon.length < 4) return polygon
  let current = polygon.slice()
  let changed = true
  while (changed && current.length > 3) {
    changed = false
    const next: Point2D[] = []
    for (let i = 0; i < current.length; i += 1) {
      const prev = current[(i - 1 + current.length) % current.length]
      const curr = current[i]
      const nxt = current[(i + 1) % current.length]
      const ax = curr.x - prev.x
      const ay = curr.y - prev.y
      const bx = nxt.x - curr.x
      const by = nxt.y - curr.y
      const aLen = Math.sqrt(ax * ax + ay * ay)
      const bLen = Math.sqrt(bx * bx + by * by)
      if (aLen < 1e-6 || bLen < 1e-6) continue
      const dot = (ax * bx + ay * by) / (aLen * bLen)
      const angle = Math.acos(Math.min(1, Math.max(-1, dot)))
      const tooShort = aLen < minEdgeMeters || bLen < minEdgeMeters
      if (angle < angleTolRad || tooShort) {
        changed = true
        continue
      }
      next.push(curr)
    }
    if (next.length < 3) break
    current = next
  }
  return current
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
    totalGroundAreaSqFt: 0,
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
  const settings = analysis?.meshSettings
  const baseZ = settings?.baseZ ?? 0
  const scaleZ = settings?.scaleZ ?? 1
  const xOffset = settings?.xOffset ?? (grid.width * grid.pixelSizeMeters) / 2
  const yOffset = settings?.yOffset ?? (grid.height * grid.pixelSizeMeters) / 2

  return createRasterMesh(grid, analysis, { baseZ, scaleZ, xOffset, yOffset })
}

export function createPlaneMeshGeometry(plane: RoofPlane): {
  vertices: number[]
  indices: number[]
} | null {
  const polygon = plane.polygon3D
  if (!polygon || polygon.length < 3) return null

  // Fan-triangulate around the polygon's centroid for robust rendering of slightly concave shapes.
  let cx = 0
  let cy = 0
  let cz = 0
  for (const point of polygon) {
    cx += point.x
    cy += point.y
    cz += point.z
  }
  cx /= polygon.length
  cy /= polygon.length
  cz /= polygon.length

  const vertices: number[] = [cx, cy, cz]
  for (const point of polygon) {
    vertices.push(point.x, point.y, point.z)
  }

  const indices: number[] = []
  for (let i = 0; i < polygon.length; i += 1) {
    const a = 0
    const b = 1 + i
    const c = 1 + ((i + 1) % polygon.length)
    indices.push(a, b, c)
  }

  return { vertices, indices }
}

type MeshRenderSettings = {
  baseZ: number
  scaleZ: number
  xOffset: number
  yOffset: number
}

function createRasterMesh(
  grid: GridData,
  analysis: RoofAnalysisResult | undefined,
  { baseZ, scaleZ, xOffset, yOffset }: MeshRenderSettings,
) {
  const vertices: number[] = []
  const colors: number[] = []
  const indices: number[] = []
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

  if (!assignments) return { vertices, indices, colors }

  for (let y = 0; y < grid.height - 1; y += 1) {
    for (let x = 0; x < grid.width - 1; x += 1) {
      const a = y * grid.width + x
      const b = a + 1
      const c = a + grid.width
      const d = c + 1

      const ida = assignments[a]
      const idb = assignments[b]
      const idc = assignments[c]
      const idd = assignments[d]
      if (ida === -1 || idb === -1 || idc === -1 || idd === -1) continue

      indices.push(a, b, c, b, d, c)
    }
  }

  return { vertices, indices, colors }
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
