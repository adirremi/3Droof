import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MapPin,
  Search,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { BufferGeometry, Float32BufferAttribute } from 'three'
import './App.css'
import { getCostScenario } from './lib/costModel'
import { analyzeDsmRoof, createMeshGeometry } from './lib/roofAnalysis'
import { createSampleRoofGrid } from './lib/sampleData'
import {
  fetchSolarPackage,
  getGoogleConfiguration,
  searchPlaces,
} from './services/googleSolar'
import type {
  AddressSuggestion,
  CostScenario,
  RoofAnalysisResult,
  SolarPackage,
} from './types'

function App() {
  const config = getGoogleConfiguration()
  const [query, setQuery] = useState('Miami Beach, FL')
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([])
  const [selectedAddress, setSelectedAddress] = useState<string>()
  const [solarPackage, setSolarPackage] = useState<SolarPackage>()
  const [analysis, setAnalysis] = useState<RoofAnalysisResult>(() =>
    analyzeDsmRoof(createSampleRoofGrid()),
  )
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState<string>()
  const [monthlyProperties, setMonthlyProperties] = useState(100)
  const [commercialFallbackRate, setCommercialFallbackRate] = useState(20)

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
        setAnalysis(analyzeDsmRoof(nextPackage.dsmGrid, nextPackage.maskGrid))
        return
      }

      setAnalysis(analyzeDsmRoof(createSampleRoofGrid()))
      setMessage(
        'Solar API responded, but DSM GeoTIFF download failed. If this persists, confirm Solar API is enabled and billing is active.',
      )
    } catch (error) {
      setAnalysis(analyzeDsmRoof(createSampleRoofGrid()))
      setMessage(
        error instanceof Error
          ? `${error.message} Showing sample roof analysis instead.`
          : 'Solar lookup failed. Showing sample roof analysis instead.',
      )
    } finally {
      setLoading(false)
    }
  }

  function handleSampleAnalysis() {
    setSolarPackage(undefined)
    setSelectedAddress('Sample hip roof, Florida residential property')
    setMessage(
      config.hasGoogleKey
        ? 'Running the PoC with synthetic DSM data. Type a Florida address above to use live Google data.'
        : 'Running the PoC with synthetic DSM data. Add a Google Maps API key for live addresses.',
    )
    setAnalysis(analyzeDsmRoof(createSampleRoofGrid()))
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
            <button type="button" className="primary" onClick={handleSampleAnalysis}>
              Run sample DSM
            </button>
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
          <div className="card-title">
            <h2>3D roof mesh</h2>
            <p>{selectedAddress ?? 'Sample DSM is loaded by default.'}</p>
          </div>
          <div className="viewer">
            <Canvas camera={{ position: [34, 28, 34], fov: 42 }}>
              <ambientLight intensity={0.8} />
              <directionalLight position={[20, 40, 20]} intensity={1.4} />
              <mesh rotation={[-Math.PI / 2.4, 0, -Math.PI / 5]}>
                <RoofGeometry grid={analysis.grid} />
                <meshStandardMaterial color="#38bdf8" roughness={0.55} metalness={0.05} />
              </mesh>
              <gridHelper args={[60, 20, '#94a3b8', '#334155']} />
              <OrbitControls enablePan enableZoom enableRotate />
            </Canvas>
          </div>
        </article>

        <article className="metrics-card">
          <div className="card-title">
            <h2>Measurements</h2>
            <p>Computed from DSM cell slopes and plane clusters.</p>
          </div>

          <div className="metric-list">
            <Metric label="Total roof area" value={`${analysis.totalAreaSqFt.toLocaleString()} sq ft`} />
            <Metric label="Average pitch" value={`${analysis.averagePitchDegrees.toFixed(1)} deg`} />
            <Metric label="Detected facets" value={analysis.planes.length.toString()} />
            <Metric label="Confidence" value={`${analysis.confidence.score}%`} />
          </div>

          <div className={`confidence ${analysis.confidence.level}`}>
            <strong>{analysis.confidence.level.toUpperCase()} confidence</strong>
            <p>{analysis.confidence.reasons.join(' ')}</p>
          </div>
        </article>
      </section>

      <section className="details-grid">
        <article className="panel">
          <div className="card-title">
            <h2>Roof facets</h2>
            <p>Plane buckets grouped by pitch and azimuth.</p>
          </div>
          <div className="facet-list">
            {analysis.planes.map((plane) => (
              <div className="facet-row" key={plane.id}>
                <span className="facet-color" style={{ background: plane.color }} />
                <strong>{plane.label}</strong>
                <span>{plane.areaSqFt.toFixed(0)} sq ft</span>
                <span>{plane.pitchDegrees.toFixed(1)} deg pitch</span>
                <span>{plane.azimuthDegrees.toFixed(0)} deg azimuth</span>
              </div>
            ))}
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
            {analysis.confidence.fallbackTriggers.map((trigger) => (
              <li key={trigger}>
                <AlertTriangle size={16} />
                {trigger}
              </li>
            ))}
          </ul>
        </article>
      </section>
    </main>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function RoofGeometry({ grid }: { grid: RoofAnalysisResult['grid'] }) {
  const geometry = useMemo(() => {
    const mesh = createMeshGeometry(grid)
    const nextGeometry = new BufferGeometry()
    nextGeometry.setAttribute('position', new Float32BufferAttribute(mesh.vertices, 3))
    nextGeometry.setIndex(mesh.indices)
    nextGeometry.computeVertexNormals()
    return nextGeometry
  }, [grid])

  return <primitive object={geometry} attach="geometry" />
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
