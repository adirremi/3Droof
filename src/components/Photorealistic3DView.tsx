import { useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import {
  TilesAttributionOverlay,
  TilesPlugin,
  TilesRenderer,
} from '3d-tiles-renderer/r3f'
import { GoogleCloudAuthPlugin, ReorientationPlugin } from '3d-tiles-renderer/plugins'
import { MathUtils } from 'three'
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
        camera={{ position: [24, 22, 24], fov: 45, near: 1, far: 1_000_000 }}
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
        <OrbitControls
          makeDefault
          target={[0, 0, 0]}
          enablePan
          enableZoom
          enableRotate
          minDistance={12}
          maxDistance={250}
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
