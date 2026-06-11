import { Canvas, useThree } from '@react-three/fiber'
import { Billboard, OrbitControls, Text } from '@react-three/drei'
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  MapPin,
  Search,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Vector3 } from 'three'
import './App.css'
import { Photorealistic3DView } from './components/Photorealistic3DView'
import { getCostScenario } from './lib/costModel'
import {
  analyzeDsmRoof,
  createMeshGeometry,
  createPlaneMeshGeometry,
} from './lib/roofAnalysis'
import {
  fetchSolarPackage,
  getGoogleApiKey,
  getGoogleConfiguration,
  searchPlaces,
} from './services/googleSolar'
import type {
  AddressSuggestion,
  CostScenario,
  RoofAnalysisResult,
  RoofPlane,
  SolarPackage,
} from './types'

function App() {
  const config = getGoogleConfiguration()
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([])
  const [selectedAddress, setSelectedAddress] = useState<string>()
  const [solarPackage, setSolarPackage] = useState<SolarPackage>()
  const [analysis, setAnalysis] = useState<RoofAnalysisResult>()
  const [selectedFacetId, setSelectedFacetId] = useState<string | undefined>()
  const [viewMode, setViewMode] = useState<'photo' | 'diagram'>('photo')
  const [loading, setLoading] = useState(false)
  const apiKey = getGoogleApiKey()
  const location = solarPackage?.place.location
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState<string>()
  const [monthlyProperties, setMonthlyProperties] = useState(100)
  const [commercialFallbackRate, setCommercialFallbackRate] = useState(20)

  const selectedFacet = useMemo(
    () => analysis?.planes.find((plane) => plane.id === selectedFacetId),
    [analysis, selectedFacetId],
  )

  const buildingRadius = useMemo(() => {
    const box = solarPackage?.buildingInsights?.boundingBox
    if (!box) return undefined
    const latMeters = Math.abs(box.ne.lat - box.sw.lat) * 111_320
    const avgLat = (box.ne.lat + box.sw.lat) / 2
    const lngMeters =
      Math.abs(box.ne.lng - box.sw.lng) * 111_320 * Math.cos((avgLat * Math.PI) / 180)
    return Math.sqrt(latMeters ** 2 + lngMeters ** 2) / 2
  }, [solarPackage])

  const costScenario: CostScenario = useMemo(
    () => getCostScenario(monthlyProperties, commercialFallbackRate),
    [commercialFallbackRate, monthlyProperties],
  )

  async function handleSearch(value: string) {
    setQuery(value)
    setMessage(undefined)

    if (value.trim().length < 3 || !config.hasGoogleKey) {
      setSuggestions([])
      return
    }

    try {
      setSearching(true)
      const matches = await searchPlaces(value)
      setSuggestions(matches)
      if (matches.length === 0) {
        setMessage(`No Google Places matches for "${value}". Try a fuller Florida address.`)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Address lookup failed.')
    } finally {
      setSearching(false)
    }
  }

  async function handleSelectAddress(suggestion: AddressSuggestion) {
    setLoading(true)
    setMessage(undefined)
    setSuggestions([])
    setQuery(suggestion.description)
    setSelectedAddress(suggestion.description)

    try {
      const nextPackage = await fetchSolarPackage(suggestion.placeId)
      setSolarPackage(nextPackage)
      const resolvedAddress = nextPackage.place.address
      setSelectedAddress(resolvedAddress)
      setQuery(resolvedAddress)

      if (nextPackage.dsmGrid) {
        setAnalysis(
          analyzeDsmRoof(nextPackage.dsmGrid, nextPackage.maskGrid, {
            place: nextPackage.place.location,
            roofSegments: nextPackage.buildingInsights?.solarPotential?.roofSegmentStats,
          }),
        )
        setSelectedFacetId(undefined)
        return
      }

      setAnalysis(undefined)
      setSelectedFacetId(undefined)
      setMessage(
        'Solar API responded, but DSM GeoTIFF download failed. Confirm Solar API is enabled and billing is active, then try again.',
      )
    } catch (error) {
      setAnalysis(undefined)
      setSelectedFacetId(undefined)
      setMessage(
        error instanceof Error
          ? error.message
          : 'Solar lookup failed. Please try a different Florida address.',
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Florida roof modeling PoC</p>
          <h1>Address to roof planes, pitch, area and confidence.</h1>
          <p className="hero-copy">
            Google Places validates the address, Google Solar API supplies building
            insights and DSM layers, and the local analyzer extracts measurable roof
            facets from elevation data.
          </p>
        </div>

        <div className="search-card">
          <label htmlFor="address">Property address</label>
          <div className="search-row">
            <Search size={18} />
            <input
              id="address"
              value={query}
              placeholder="Start typing a Florida address"
              onChange={(event) => handleSearch(event.target.value)}
            />
          </div>

          {suggestions.length > 0 && (
            <div className="suggestions">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.placeId}
                  type="button"
                  onClick={() => handleSelectAddress(suggestion)}
                >
                  <MapPin size={16} />
                  {suggestion.description}
                </button>
              ))}
            </div>
          )}

          <div className="actions">
            <span className={config.hasValidKeyShape ? 'status ok' : 'status warn'}>
              {config.hasValidKeyShape ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
              {config.hasValidKeyShape
                ? 'Google key configured'
                : config.hasGoogleKey
                  ? 'Google key does not look valid'
                  : 'Missing VITE_GOOGLE_MAPS_API_KEY'}
            </span>
            {searching && (
              <span className="status">
                <Loader2 size={16} className="spin" />
                Searching Google Places
              </span>
            )}
          </div>

          {config.hasValidKeyShape && (
            <p className="notice referrer-hints">
              Open this exact URL in the browser. In Google Cloud key referrers add:{' '}
              {config.referrerHints.join(' · ')}
            </p>
          )}

          {message && <p className="notice">{message}</p>}
          {loading && (
            <p className="notice loading">
              <Loader2 size={16} />
              Fetching address, Solar API metadata and DSM layers.
            </p>
          )}
        </div>
      </section>

      <section className="dashboard-grid">
        <article className="viewer-card">
          <div className="card-title viewer-title">
            <div>
              <h2>3D roof</h2>
              <p>{selectedAddress ?? 'Pick a Florida address above to render the roof.'}</p>
            </div>
            {location && apiKey && (
              <div className="view-toggle" role="tablist">
                <button
                  type="button"
                  className={viewMode === 'photo' ? 'active' : ''}
                  onClick={() => setViewMode('photo')}
                >
                  <ImageIcon size={15} />
                  Photo 3D
                </button>
                <button
                  type="button"
                  className={viewMode === 'diagram' ? 'active' : ''}
                  onClick={() => setViewMode('diagram')}
                >
                  <Box size={15} />
                  Diagram
                </button>
              </div>
            )}
          </div>
          <div className="viewer">
            {location && apiKey && viewMode === 'photo' ? (
              <Photorealistic3DView
                location={location}
                apiKey={apiKey}
                buildingRadius={buildingRadius}
              />
            ) : analysis ? (
              <>
                <Canvas
                  camera={{ position: [40, 32, 40], fov: 45, near: 0.1, far: 2000 }}
                  onPointerMissed={() => setSelectedFacetId(undefined)}
                >
                  <ambientLight intensity={0.7} />
                  <directionalLight position={[40, 80, 30]} intensity={1.3} />
                  <directionalLight position={[-40, 30, -20]} intensity={0.5} />
                  <DiagramAutoFit analysis={analysis} />
                  <group rotation={[-Math.PI / 2, 0, 0]}>
                    {analysis.planes.some((plane) => plane.polygon3D?.length) ? (
                      analysis.planes.map((plane) => (
                        <PlaneMesh
                          key={plane.id}
                          plane={plane}
                          isSelected={plane.id === selectedFacetId}
                          onSelect={() => setSelectedFacetId(plane.id)}
                        />
                      ))
                    ) : (
                      <mesh>
                        <RoofGeometry analysis={analysis} />
                        <meshStandardMaterial
                          vertexColors
                          roughness={0.55}
                          metalness={0.05}
                          flatShading
                          side={DoubleSide}
                        />
                      </mesh>
                    )}
                    {analysis.planes.map((plane) => (
                      <Billboard
                        key={`label-${plane.id}`}
                        position={[plane.centroid.x, plane.centroid.y, plane.centroid.z + 1.2]}
                      >
                        <Text
                          fontSize={1.6}
                          color="white"
                          anchorX="center"
                          anchorY="middle"
                          outlineColor="#0f172a"
                          outlineWidth={0.12}
                        >
                          {plane.letter}
                        </Text>
                      </Billboard>
                    ))}
                  </group>
                  <gridHelper args={[120, 24, '#94a3b8', '#334155']} />
                  <OrbitControls enablePan enableZoom enableRotate makeDefault />
                </Canvas>
                {selectedFacet && (
                  <FacetDetailsCard
                    plane={selectedFacet}
                    onClose={() => setSelectedFacetId(undefined)}
                  />
                )}
              </>
            ) : (
              <div className="viewer-empty">
                <MapPin size={28} />
                <p>Select a Florida address to load the live DSM and render its roof.</p>
              </div>
            )}
          </div>
        </article>

        <article className="metrics-card">
          <div className="card-title">
            <h2>Measurements</h2>
            <p>Computed from DSM cell slopes and plane clusters.</p>
          </div>

          {analysis ? (
            <>
              <div className="metric-list">
                <Metric
                  label="Roof surface area"
                  hint="Tilted area — use for shingles/material"
                  value={`${analysis.totalAreaSqFt.toLocaleString()} sq ft`}
                />
                <Metric
                  label="Footprint area"
                  hint="Ground projection (plan view)"
                  value={`${analysis.totalGroundAreaSqFt.toLocaleString()} sq ft`}
                />
                <Metric
                  label="Average pitch"
                  value={`${analysis.averagePitchDegrees.toFixed(1)}° · ${pitchToRatio(analysis.averagePitchDegrees)}`}
                />
                <Metric label="Detected facets" value={analysis.planes.length.toString()} />
                <Metric label="Confidence" value={`${analysis.confidence.score}%`} />
              </div>

              <div className={`confidence ${analysis.confidence.level}`}>
                <strong>{analysis.confidence.level.toUpperCase()} confidence</strong>
                <p>{analysis.confidence.reasons.join(' ')}</p>
              </div>
            </>
          ) : (
            <p className="notice">Waiting for an address selection to compute measurements.</p>
          )}
        </article>
      </section>

      <section className="details-grid">
        <article className="panel">
          <div className="card-title">
            <h2>Roof facets</h2>
            <p>Plane buckets grouped by pitch and azimuth.</p>
          </div>
          <div className="facet-list">
            {analysis?.planes.length ? (
              analysis.planes.map((plane) => (
                <button
                  className={`facet-row${plane.id === selectedFacetId ? ' selected' : ''}`}
                  key={plane.id}
                  type="button"
                  onClick={() => setSelectedFacetId(plane.id)}
                >
                  <span
                    className="facet-color"
                    style={{ background: plane.color }}
                    aria-hidden
                  >
                    {plane.letter}
                  </span>
                  <strong>{plane.label}</strong>
                  <span>{Math.round(plane.areaSqFt).toLocaleString()} sq ft</span>
                  <span>{plane.pitchDegrees.toFixed(1)}° pitch</span>
                  <span>{plane.azimuthDegrees.toFixed(0)}° azimuth</span>
                </button>
              ))
            ) : (
              <p className="notice">Facets appear after a roof is analyzed.</p>
            )}
          </div>
        </article>

        <article className="panel">
          <div className="card-title">
            <h2>API validation</h2>
            <p>Live checks the app performs for each address.</p>
          </div>
          <ul className="check-list">
            <CheckItem ok={config.hasValidKeyShape} text="Google Maps API key looks valid." />
            <CheckItem ok={Boolean(solarPackage?.place)} text="Place Details returned lat/lng." />
            <CheckItem
              ok={Boolean(solarPackage?.buildingInsights)}
              text="Solar Building Insights found a nearby building."
            />
            <CheckItem ok={Boolean(solarPackage?.dataLayers)} text="Solar Data Layers returned DSM/RGB/mask URLs." />
            <CheckItem ok={Boolean(solarPackage?.dsmGrid)} text="DSM GeoTIFF was downloaded and parsed." />
          </ul>
        </article>

        <article className="panel">
          <div className="card-title">
            <h2>Cost model</h2>
            <p>Low-budget Google-first flow with commercial fallback.</p>
          </div>
          <div className="cost-controls">
            <label>
              Properties / month
              <input
                type="number"
                min={1}
                value={monthlyProperties}
                onChange={(event) => setMonthlyProperties(Number(event.target.value))}
              />
            </label>
            <label>
              Fallback %
              <input
                type="number"
                min={0}
                max={100}
                value={commercialFallbackRate}
                onChange={(event) => setCommercialFallbackRate(Number(event.target.value))}
              />
            </label>
          </div>
          <div className="metric-list compact">
            <Metric label="Google MVP estimate" value={`$${costScenario.googleOnlyMonthly.toFixed(0)} / mo`} />
            <Metric label="Fallback reports" value={costScenario.fallbackReports.toString()} />
            <Metric label="Commercial fallback" value={`$${costScenario.fallbackMonthly.toFixed(0)} / mo`} />
            <Metric label="Blended estimate" value={`$${costScenario.blendedMonthly.toFixed(0)} / mo`} />
          </div>
          <p>
            Pricing varies by contract and SKU. The model keeps Google as the default path
            and reserves EagleView/Nearmap-style reports for low-confidence roofs.
          </p>
        </article>

        <article className="panel">
          <div className="card-title">
            <h2>Fallback rules</h2>
            <p>When the app should ask for paid measurement data.</p>
          </div>
          <ul className="check-list">
            {analysis?.confidence.fallbackTriggers.length ? (
              analysis.confidence.fallbackTriggers.map((trigger) => (
                <li key={trigger}>
                  <AlertTriangle size={16} />
                  {trigger}
                </li>
              ))
            ) : (
              <li>
                <AlertTriangle size={16} />
                Triggers populate after the first analyzed address.
              </li>
            )}
          </ul>
        </article>
      </section>
    </main>
  )
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="metric">
      <span className="metric-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <strong>{value}</strong>
    </div>
  )
}

function pitchToRatio(pitchDegrees: number): string {
  if (pitchDegrees <= 0.5) return 'flat'
  const rise = Math.round(12 * Math.tan((pitchDegrees * Math.PI) / 180))
  return `${rise}:12`
}

function RoofGeometry({ analysis }: { analysis: RoofAnalysisResult }) {
  const geometry = useMemo(() => {
    const mesh = createMeshGeometry(analysis.grid, analysis)
    const nextGeometry = new BufferGeometry()
    nextGeometry.setAttribute('position', new Float32BufferAttribute(mesh.vertices, 3))
    if (mesh.colors.length === mesh.vertices.length) {
      nextGeometry.setAttribute('color', new Float32BufferAttribute(mesh.colors, 3))
    }
    nextGeometry.setIndex(mesh.indices)
    nextGeometry.computeVertexNormals()
    return nextGeometry
  }, [analysis])

  return <primitive object={geometry} attach="geometry" />
}

function PlaneMesh({
  plane,
  isSelected,
  onSelect,
}: {
  plane: RoofPlane
  isSelected: boolean
  onSelect: () => void
}) {
  const geometry = useMemo(() => {
    const result = createPlaneMeshGeometry(plane)
    if (!result) return undefined
    const next = new BufferGeometry()
    next.setAttribute('position', new Float32BufferAttribute(result.vertices, 3))
    next.setIndex(result.indices)
    next.computeVertexNormals()
    return next
  }, [plane])

  const outlineGeometry = useMemo(() => {
    const polygon = plane.polygon3D
    if (!polygon || polygon.length < 3) return undefined
    const points: number[] = []
    // Lift slightly above the surface to avoid z-fighting with the fill.
    for (const p of polygon) points.push(p.x, p.y, p.z + 0.06)
    const next = new BufferGeometry()
    next.setAttribute('position', new Float32BufferAttribute(points, 3))
    return next
  }, [plane])

  if (!geometry) return null

  return (
    <group>
      <mesh
        geometry={geometry}
        onClick={(event) => {
          event.stopPropagation()
          onSelect()
        }}
        onPointerOver={(event) => {
          event.stopPropagation()
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          document.body.style.cursor = 'auto'
        }}
      >
        <meshStandardMaterial
          color={plane.color}
          roughness={0.65}
          metalness={0.05}
          flatShading
          side={DoubleSide}
          emissive={isSelected ? plane.color : '#000000'}
          emissiveIntensity={isSelected ? 0.45 : 0}
        />
      </mesh>
      {outlineGeometry && (
        <lineLoop geometry={outlineGeometry}>
          <lineBasicMaterial color={isSelected ? '#ffffff' : '#0f172a'} />
        </lineLoop>
      )}
    </group>
  )
}

// Positions the camera to frame the analyzed roof regardless of building size.
function DiagramAutoFit({ analysis }: { analysis: RoofAnalysisResult }) {
  const { camera, controls } = useThree()

  useEffect(() => {
    const points: Vector3[] = []
    for (const plane of analysis.planes) {
      for (const p of plane.polygon3D ?? []) {
        // Mesh coords (x, y, z) sit inside a group rotated -90° about X => world (x, z, -y).
        points.push(new Vector3(p.x, p.z, -p.y))
      }
    }
    if (points.length === 0) return

    const center = points
      .reduce((acc, p) => acc.add(p), new Vector3())
      .divideScalar(points.length)
    let radius = 8
    for (const p of points) {
      radius = Math.max(radius, p.distanceTo(center))
    }

    const distance = Math.max(radius * 2.4, 16)
    const dir = new Vector3(1, 0.75, 1).normalize()
    camera.position.copy(center).addScaledVector(dir, distance)
    camera.lookAt(center)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orbit = controls as any
    if (orbit?.target) {
      orbit.target.copy(center)
      orbit.update?.()
    }
  }, [analysis, camera, controls])

  return null
}

function FacetDetailsCard({ plane, onClose }: { plane: RoofPlane; onClose: () => void }) {
  return (
    <div className="facet-card">
      <button className="facet-card-close" type="button" onClick={onClose} aria-label="Close">
        <X size={16} />
      </button>
      <div className="facet-card-header">
        <span className="facet-card-color" style={{ background: plane.color }}>
          {plane.letter}
        </span>
        <div>
          <strong>{plane.label}</strong>
          <p>{compassLabel(plane.azimuthDegrees)} facing</p>
        </div>
      </div>
      <div className="facet-card-grid">
        <div>
          <span>Pitch</span>
          <strong>{plane.pitchDegrees.toFixed(1)}°</strong>
          <small>{pitchToRatio(plane.pitchDegrees)}</small>
        </div>
        <div>
          <span>Azimuth</span>
          <strong>{plane.azimuthDegrees.toFixed(0)}°</strong>
          <small>{compassLabel(plane.azimuthDegrees)}</small>
        </div>
        <div>
          <span>Surface</span>
          <strong>{Math.round(plane.areaSqFt).toLocaleString()}</strong>
          <small>sq ft (tilted)</small>
        </div>
        <div>
          <span>Footprint</span>
          <strong>{Math.round(plane.groundAreaSqFt).toLocaleString()}</strong>
          <small>sq ft (plan)</small>
        </div>
      </div>
    </div>
  )
}

function compassLabel(azimuthDegrees: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const index = Math.round((((azimuthDegrees % 360) + 360) % 360) / 45) % 8
  return dirs[index]
}

function CheckItem({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className={ok ? 'ok' : 'pending'}>
      {ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
      {text}
    </li>
  )
}

export default App
