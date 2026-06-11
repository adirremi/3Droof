import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import {
  TilesAttributionOverlay,
  TilesPlugin,
  TilesRenderer,
} from '3d-tiles-renderer/r3f'
import {
  GLTFExtensionsPlugin,
  GoogleCloudAuthPlugin,
  ReorientationPlugin,
  TilesFadePlugin,
  UnloadTilesPlugin,
} from '3d-tiles-renderer/plugins'
import { MathUtils, Raycaster, Vector3, type WebGLRenderer } from 'three'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import type { LatLng } from '../types'

type Props = {
  location: LatLng
  apiKey: string
  buildingRadius?: number
}

const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/'
const KTX2_TRANSCODER_PATH = 'https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs/basis/'

// Renders Google's Photorealistic 3D Tiles (the same textured mesh used by Google Maps 3D),
// re-centered on the target building so the user can orbit around it like a real 3D photo.
export function Photorealistic3DView({ location, apiKey, buildingRadius }: Props) {
  const [error, setError] = useState<string>()

  const lat = location.lat * MathUtils.DEG2RAD
  const lon = location.lng * MathUtils.DEG2RAD
  const remountKey = `${location.lat.toFixed(6)},${location.lng.toFixed(6)}`

  // Final orbit distance scales with the actual building footprint.
  const settleDistance = Math.min(Math.max((buildingRadius ?? 18) * 2.3, 30), 110)

  useEffect(() => {
    setError(undefined)
  }, [remountKey])

  return (
    <>
      <Canvas
        camera={{ position: [70, 55, 70], fov: 50, near: 1, far: 1_000_000 }}
        gl={{ logarithmicDepthBuffer: true, antialias: true }}
      >
        <ambientLight intensity={1.2} />
        <directionalLight position={[200, 400, 200]} intensity={1.1} />
        <TilesScene
          apiKey={apiKey}
          lat={lat}
          lon={lon}
          remountKey={remountKey}
          onError={setError}
        />
        <GroundSettler resetKey={remountKey} settleDistance={settleDistance} />
        <OrbitControls
          makeDefault
          enablePan
          enableZoom
          enableRotate
          minDistance={12}
          maxDistance={220}
          maxPolarAngle={Math.PI / 2.05}
        />
      </Canvas>
      {error && (
        <div className="tiles-error">
          <strong>3D photo unavailable here.</strong>
          <p>
            Enable the “Map Tiles API” in the same Google Cloud project as your key, or this
            location may not have photorealistic coverage yet. Switch to Diagram view for the
            measured roof model.
          </p>
        </div>
      )}
    </>
  )
}

type TilesSceneProps = {
  apiKey: string
  lat: number
  lon: number
  remountKey: string
  onError: (message: string) => void
}

// Sets up the tileset with the loaders Google's tiles need (Draco geometry + KTX2 textures),
// otherwise tiles render as untextured grey squares.
function TilesScene({ apiKey, lat, lon, remountKey, onError }: TilesSceneProps) {
  const gl = useThree((state) => state.gl) as WebGLRenderer

  const loaders = useMemo(() => {
    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath(DRACO_DECODER_PATH)
    const ktxLoader = new KTX2Loader()
    ktxLoader.setTranscoderPath(KTX2_TRANSCODER_PATH)
    ktxLoader.detectSupport(gl)
    return { dracoLoader, ktxLoader }
  }, [gl])

  return (
    <TilesRenderer
      key={remountKey}
      // Lower error target = sharper, higher-detail tiles near the building.
      errorTarget={6}
      onLoadError={((event: { error?: { message?: string } }) => {
        onError(String(event?.error?.message ?? 'Failed to load 3D tiles.'))
      }) as never}
    >
      <TilesPlugin
        plugin={GoogleCloudAuthPlugin}
        args={[{ apiToken: apiKey, autoRefreshToken: true }] as never}
      />
      <TilesPlugin
        plugin={GLTFExtensionsPlugin}
        args={[{ dracoLoader: loaders.dracoLoader, ktxLoader: loaders.ktxLoader }] as never}
      />
      <TilesPlugin
        plugin={ReorientationPlugin}
        args={[{ lat, lon, height: 0, recenter: true }] as never}
      />
      <TilesPlugin plugin={TilesFadePlugin} />
      <TilesPlugin plugin={UnloadTilesPlugin} />
      <TilesAttributionOverlay />
    </TilesRenderer>
  )
}

// The reoriented globe puts the ellipsoid surface at the origin, but the real ground sits below
// it by the local geoid offset (~30m in Florida). This raycasts down onto the loaded tiles to
// find the actual roof/ground height and recenters the orbit so the building fills the frame.
function GroundSettler({
  resetKey,
  settleDistance,
}: {
  resetKey: string
  settleDistance: number
}) {
  const { scene, camera, controls } = useThree()
  const raycaster = useRef(new Raycaster())
  const settled = useRef(false)
  const attempts = useRef(0)

  useEffect(() => {
    settled.current = false
    attempts.current = 0
  }, [resetKey])

  useFrame(() => {
    if (settled.current) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orbit = controls as any
    if (!orbit?.target) return

    attempts.current += 1
    // Stop hammering the raycaster if coverage never loads (keeps the wide framing).
    if (attempts.current > 1200) {
      settled.current = true
      return
    }

    raycaster.current.set(new Vector3(0, 8000, 0), new Vector3(0, -1, 0))
    raycaster.current.far = 40000
    const hits = raycaster.current.intersectObject(scene, true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hit = hits.find((entry) => (entry.object as any).isMesh)
    if (!hit) return

    // Recenter the orbit on the real roof height and pull in for a tight, building-filling view.
    const groundY = hit.point.y
    const dir = new Vector3().subVectors(camera.position, orbit.target)
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.85, 1)
    dir.normalize()
    orbit.target.set(0, groundY, 0)
    camera.position.copy(orbit.target).addScaledVector(dir, settleDistance)
    orbit.update?.()
    settled.current = true
  })

  return null
}
