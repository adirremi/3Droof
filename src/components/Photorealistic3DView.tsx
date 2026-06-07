import { useEffect, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import {
  TilesAttributionOverlay,
  TilesPlugin,
  TilesRenderer,
} from '3d-tiles-renderer/r3f'
import { GoogleCloudAuthPlugin, ReorientationPlugin } from '3d-tiles-renderer/plugins'
import { MathUtils, Raycaster, Vector3 } from 'three'
import type { LatLng } from '../types'

type Props = {
  location: LatLng
  apiKey: string
}

// Renders Google's Photorealistic 3D Tiles (the same textured mesh used by Google Maps 3D),
// re-centered on the target building so the user can orbit around it like a real 3D photo.
export function Photorealistic3DView({ location, apiKey }: Props) {
  const [error, setError] = useState<string>()

  const lat = location.lat * MathUtils.DEG2RAD
  const lon = location.lng * MathUtils.DEG2RAD
  const remountKey = `${location.lat.toFixed(6)},${location.lng.toFixed(6)}`

  useEffect(() => {
    setError(undefined)
  }, [remountKey])

  return (
    <>
      <Canvas
        camera={{ position: [22, 18, 22], fov: 42, near: 1, far: 1_000_000 }}
        gl={{ logarithmicDepthBuffer: true, antialias: true }}
      >
        <ambientLight intensity={1.2} />
        <directionalLight position={[200, 400, 200]} intensity={1.1} />
        <TilesRenderer
          key={remountKey}
          onLoadError={((event: { error?: { message?: string } }) => {
            setError(String(event?.error?.message ?? 'Failed to load 3D tiles.'))
          }) as never}
        >
          <TilesPlugin
            plugin={GoogleCloudAuthPlugin}
            args={[{ apiToken: apiKey, autoRefreshToken: true }] as never}
          />
          <TilesPlugin
            plugin={ReorientationPlugin}
            args={[{ lat, lon, height: 0, recenter: true }] as never}
          />
          <TilesAttributionOverlay />
        </TilesRenderer>
        <GroundSettler resetKey={remountKey} />
        <OrbitControls
          makeDefault
          enablePan
          enableZoom
          enableRotate
          minDistance={12}
          maxDistance={180}
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

// The reoriented globe puts the ellipsoid surface at the origin, but the real ground sits below
// it by the local geoid offset (~30m in Florida). This raycasts down onto the loaded tiles to
// find the actual roof/ground height and recenters the orbit so the building fills the frame.
function GroundSettler({ resetKey }: { resetKey: string }) {
  const { scene, camera, controls } = useThree()
  const raycaster = useRef(new Raycaster())
  const settled = useRef(false)

  useEffect(() => {
    settled.current = false
  }, [resetKey])

  useFrame(() => {
    if (settled.current) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orbit = controls as any
    if (!orbit?.target) return

    raycaster.current.set(new Vector3(0, 8000, 0), new Vector3(0, -1, 0))
    raycaster.current.far = 40000
    const hits = raycaster.current.intersectObject(scene, true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hit = hits.find((entry) => (entry.object as any).isMesh)
    if (!hit) return

    const groundY = hit.point.y
    const offset = new Vector3().subVectors(camera.position, orbit.target)
    orbit.target.set(0, groundY, 0)
    camera.position.copy(orbit.target).add(offset)
    orbit.update?.()
    settled.current = true
  })

  return null
}
