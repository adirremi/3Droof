import { readGeoTiffGrid } from '../lib/geotiff'
import type {
  AddressSuggestion,
  GridData,
  PlaceLocation,
  SolarBuildingInsights,
  SolarDataLayers,
  SolarPackage,
} from '../types'

const GOOGLE_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
const PLACES_LANGUAGE = 'en'
let mapsScriptPromise: Promise<void> | undefined

export function getGoogleConfiguration() {
  const key = normalizeKey(GOOGLE_KEY)

  return {
    hasGoogleKey: Boolean(key),
    hasValidKeyShape: Boolean(key?.startsWith('AIza') && key.length > 30),
    referrerHints: getReferrerHints(),
  }
}

export function getReferrerHints() {
  if (typeof window === 'undefined') {
    return [
      'https://3-droof.vercel.app/*',
      'https://*.vercel.app/*',
      'http://127.0.0.1:5173/*',
      'http://localhost:5173/*',
    ]
  }

  const { protocol, hostname, port } = window.location
  const hostWithPort = port ? `${hostname}:${port}` : hostname

  return [
    `${protocol}//${hostWithPort}/*`,
    'https://3-droof.vercel.app/*',
    'https://*.vercel.app/*',
    'http://127.0.0.1:5173/*',
    'http://localhost:5173/*',
  ].filter((value, index, list) => list.indexOf(value) === index)
}

export async function searchPlaces(input: string): Promise<AddressSuggestion[]> {
  assertGoogleKey()
  await loadGoogleMapsScript()

  try {
    return await searchPlacesWithNewApi(input)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('blocked') && !message.includes('AutocompletePlaces')) {
      throw new Error(formatPlacesError(error))
    }

    try {
      return await searchPlacesWithLegacyApi(input)
    } catch {
      throw new Error(formatPlacesError(error, getReferrerHints()))
    }
  }
}

async function searchPlacesWithNewApi(input: string) {
  const request: google.maps.places.AutocompleteRequest = {
    input,
    includedRegionCodes: ['us'],
    language: PLACES_LANGUAGE,
    locationBias: new google.maps.LatLngBounds(
      { lat: 24.396308, lng: -87.634938 },
      { lat: 31.000888, lng: -79.974307 },
    ),
    region: 'us',
    sessionToken: new google.maps.places.AutocompleteSessionToken(),
  }

  const response = await withTimeout(
    google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions(request),
    7000,
    'Google Places did not respond. Check that the API key is valid and Maps JavaScript API is enabled.',
  )

  return response.suggestions
    .map((suggestion) => suggestion.placePrediction)
    .filter((prediction): prediction is google.maps.places.PlacePrediction => Boolean(prediction))
    .map((prediction) => ({
      placeId: prediction.placeId,
      description: prediction.text.text,
    }))
}

async function searchPlacesWithLegacyApi(input: string) {
  const service = new google.maps.places.AutocompleteService()

  const predictions = await new Promise<google.maps.places.AutocompletePrediction[]>(
    (resolve, reject) => {
      service.getPlacePredictions(
        {
          input,
          componentRestrictions: { country: 'us' },
          language: PLACES_LANGUAGE,
        },
        (results, status) => {
          if (status === 'OK' && results) {
            resolve(results)
            return
          }

          if (status === 'ZERO_RESULTS') {
            resolve([])
            return
          }

          reject(new Error(`Legacy Places autocomplete failed: ${status}`))
        },
      )
    },
  )

  return predictions.map((prediction) => ({
    placeId: prediction.place_id,
    description: prediction.description,
  }))
}

export async function getPlaceFromMapsLibrary(placeId: string): Promise<PlaceLocation> {
  assertGoogleKey()
  await loadGoogleMapsScript()

  try {
    return await getPlaceWithNewApi(placeId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      message.includes('GetPlace') ||
      message.includes('blocked') ||
      message.includes('PERMISSION_DENIED')
    ) {
      try {
        return await getPlaceWithLegacyApi(placeId)
      } catch {
        throw new Error(formatPlacesError(error, getReferrerHints()))
      }
    }

    throw new Error(formatPlacesError(error, getReferrerHints()))
  }
}

async function getPlaceWithNewApi(placeId: string): Promise<PlaceLocation> {
  const place = new google.maps.places.Place({
    id: placeId,
    requestedLanguage: PLACES_LANGUAGE,
    requestedRegion: 'us',
  })
  const result = await place.fetchFields({ fields: ['formattedAddress', 'location'] })

  if (!result.place.location) {
    throw new Error('Place Details did not return a location.')
  }

  return {
    address: result.place.formattedAddress ?? placeId,
    location: {
      lat: result.place.location.lat(),
      lng: result.place.location.lng(),
    },
  }
}

async function getPlaceWithLegacyApi(placeId: string): Promise<PlaceLocation> {
  const placesService = new google.maps.places.PlacesService(document.createElement('div'))
  const result = await new Promise<google.maps.places.PlaceResult>((resolve, reject) => {
    placesService.getDetails(
      { placeId, fields: ['formatted_address', 'geometry'] },
      (place, status) => {
        if (status === 'OK' && place?.geometry?.location) {
          resolve(place)
          return
        }

        reject(new Error(`Legacy Place Details failed: ${status}`))
      },
    )
  })

  return {
    address: result.formatted_address ?? placeId,
    location: {
      lat: result.geometry!.location!.lat(),
      lng: result.geometry!.location!.lng(),
    },
  }
}

export async function fetchSolarPackage(placeId: string): Promise<SolarPackage> {
  assertGoogleKey()

  const place = await getPlaceFromMapsLibrary(placeId)
  const buildingInsights = await fetchBuildingInsights(place.location)
  const radius = computeBuildingRadius(buildingInsights)
  const dataLayers = await fetchDataLayersWithFallback(place.location, radius)

  const apiKey = normalizeKey(GOOGLE_KEY)!
  const [rawDsmGrid, rawMaskGrid] = await Promise.all([
    dataLayers?.dsmUrl ? readGeoTiffGrid(dataLayers.dsmUrl, undefined, apiKey) : undefined,
    dataLayers?.maskUrl ? readGeoTiffGrid(dataLayers.maskUrl, undefined, apiKey) : undefined,
  ])

  const cropMask = rawDsmGrid
    ? buildBuildingFootprintMask(rawDsmGrid, place.location, buildingInsights)
    : undefined
  const maskGrid = combineMasks(rawDsmGrid, rawMaskGrid, cropMask)

  return {
    place,
    buildingInsights,
    dataLayers,
    dsmGrid: rawDsmGrid,
    maskGrid,
  }
}

function buildBuildingFootprintMask(
  grid: GridData,
  place: PlaceLocation['location'],
  insights: SolarBuildingInsights | undefined,
): GridData | undefined {
  const box = insights?.boundingBox
  if (!box) {
    return undefined
  }

  const avgLat = (box.ne.lat + box.sw.lat) / 2
  const metersPerDegLat = 111_320
  const metersPerDegLng = 111_320 * Math.cos((avgLat * Math.PI) / 180)

  const dxCenterMeters = ((box.ne.lng + box.sw.lng) / 2 - place.lng) * metersPerDegLng
  const dyCenterMeters = ((box.ne.lat + box.sw.lat) / 2 - place.lat) * metersPerDegLat
  const halfWidthMeters = ((box.ne.lng - box.sw.lng) / 2) * metersPerDegLng + 0.5
  const halfHeightMeters = ((box.ne.lat - box.sw.lat) / 2) * metersPerDegLat + 0.5

  const centerX = grid.width / 2 + dxCenterMeters / grid.pixelSizeMeters
  const centerY = grid.height / 2 - dyCenterMeters / grid.pixelSizeMeters
  const halfWidthPx = halfWidthMeters / grid.pixelSizeMeters
  const halfHeightPx = halfHeightMeters / grid.pixelSizeMeters

  const values = new Float32Array(grid.width * grid.height)
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const inside =
        Math.abs(x + 0.5 - centerX) <= halfWidthPx &&
        Math.abs(y + 0.5 - centerY) <= halfHeightPx
      values[y * grid.width + x] = inside ? 1 : 0
    }
  }

  return {
    width: grid.width,
    height: grid.height,
    pixelSizeMeters: grid.pixelSizeMeters,
    values,
  }
}

function combineMasks(
  grid: GridData | undefined,
  ...masks: (GridData | undefined)[]
): GridData | undefined {
  if (!grid) {
    return undefined
  }

  const active = masks.filter((mask): mask is GridData => Boolean(mask))
  if (active.length === 0) {
    return undefined
  }

  if (active.length === 1) {
    return active[0]
  }

  const values = new Float32Array(grid.width * grid.height)
  for (let index = 0; index < values.length; index += 1) {
    let combined = 1
    for (const mask of active) {
      const value = mask.values[index]
      if (!Number.isFinite(value) || value <= 0) {
        combined = 0
        break
      }
    }
    values[index] = combined
  }

  return {
    width: grid.width,
    height: grid.height,
    pixelSizeMeters: grid.pixelSizeMeters,
    values,
  }
}

type GoogleLatLng = {
  latitude?: number
  longitude?: number
}

type RawSolarBuildingInsights = Omit<SolarBuildingInsights, 'boundingBox'> & {
  boundingBox?: {
    sw?: GoogleLatLng
    ne?: GoogleLatLng
  }
  error?: { message?: string }
}

async function fetchBuildingInsights(
  location: PlaceLocation['location'],
): Promise<SolarBuildingInsights> {
  const url = new URL('https://solar.googleapis.com/v1/buildingInsights:findClosest')
  url.searchParams.set('location.latitude', location.lat.toString())
  url.searchParams.set('location.longitude', location.lng.toString())
  url.searchParams.set('requiredQuality', 'MEDIUM')
  url.searchParams.set('key', GOOGLE_KEY!)

  const response = await fetch(url)
  const data = (await response.json()) as RawSolarBuildingInsights

  if (!response.ok || data.error) {
    throw new Error(data.error?.message ?? 'Solar Building Insights did not find a building.')
  }

  const normalizeLatLng = (point?: GoogleLatLng) => {
    if (!point || point.latitude === undefined || point.longitude === undefined) {
      return undefined
    }
    return { lat: point.latitude, lng: point.longitude }
  }

  const sw = normalizeLatLng(data.boundingBox?.sw)
  const ne = normalizeLatLng(data.boundingBox?.ne)

  return {
    name: data.name,
    imageryQuality: data.imageryQuality,
    boundingBox: sw && ne ? { sw, ne } : undefined,
    solarPotential: data.solarPotential,
  }
}

async function fetchDataLayersWithFallback(
  location: PlaceLocation['location'],
  preferredRadius: number,
) {
  const attempts: Array<{ radius: number; pixelSize: string; quality: string }> = [
    { radius: clampSolarRadius(preferredRadius), pixelSize: '0.25', quality: 'MEDIUM' },
    { radius: clampSolarRadius(preferredRadius), pixelSize: '0.5', quality: 'MEDIUM' },
    { radius: 50, pixelSize: '0.5', quality: 'MEDIUM' },
    { radius: 50, pixelSize: '1.0', quality: 'LOW' },
  ]

  let lastError: Error | undefined

  for (const attempt of attempts) {
    try {
      return await fetchDataLayers(location, attempt.radius, attempt.pixelSize, attempt.quality)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const message = lastError.message.toLowerCase()
      const recoverable =
        message.includes('invalid argument') ||
        message.includes('invalid_argument') ||
        message.includes('unsupported') ||
        message.includes('pixelsize') ||
        message.includes('radius')

      if (!recoverable) {
        throw lastError
      }
    }
  }

  throw lastError ?? new Error('Solar Data Layers are unavailable for this address.')
}

async function fetchDataLayers(
  location: PlaceLocation['location'],
  radiusMeters: number,
  pixelSizeMeters: string,
  requiredQuality: string,
) {
  const url = new URL('https://solar.googleapis.com/v1/dataLayers:get')
  url.searchParams.set('location.latitude', location.lat.toString())
  url.searchParams.set('location.longitude', location.lng.toString())
  url.searchParams.set('radiusMeters', radiusMeters.toString())
  url.searchParams.set('view', 'FULL_LAYERS')
  url.searchParams.set('requiredQuality', requiredQuality)
  url.searchParams.set('pixelSizeMeters', pixelSizeMeters)
  url.searchParams.set('key', GOOGLE_KEY!)

  const response = await fetch(url)
  const data = (await response.json()) as SolarDataLayers & {
    error?: { message?: string }
  }

  if (!response.ok || data.error) {
    throw new Error(data.error?.message ?? 'Solar Data Layers are unavailable for this address.')
  }

  return data
}

function clampSolarRadius(radius: number) {
  if (!Number.isFinite(radius)) {
    return 30
  }
  return Math.max(25, Math.min(100, Math.ceil(radius)))
}

function assertGoogleKey() {
  const key = normalizeKey(GOOGLE_KEY)

  if (!key) {
    throw new Error('Set VITE_GOOGLE_MAPS_API_KEY to use live Google Places and Solar API data.')
  }

  if (!key.startsWith('AIza') || key.length <= 30) {
    throw new Error('VITE_GOOGLE_MAPS_API_KEY does not look like a Google Maps API key. It should start with AIza.')
  }
}

function loadGoogleMapsScript() {
  if (globalThis.google?.maps?.places) {
    return Promise.resolve()
  }

  mapsScriptPromise ??= new Promise<void>((resolve, reject) => {
    ;(globalThis as typeof globalThis & { gm_authFailure?: () => void }).gm_authFailure = () => {
      reject(new Error('Google Maps authentication failed. Check API restrictions and enabled APIs.'))
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[data-google-maps-loader="true"]',
    )

    if (existingScript) {
      existingScript.addEventListener('load', () => resolve())
      existingScript.addEventListener('error', () => reject(new Error('Google Maps script failed to load.')))
      return
    }

    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${normalizeKey(GOOGLE_KEY)}&libraries=places&language=en&region=US&v=weekly`
    script.async = true
    script.defer = true
    script.dataset.googleMapsLoader = 'true'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Google Maps script failed to load.'))
    document.head.appendChild(script)
  })

  return mapsScriptPromise
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string) {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)

    promise
      .then((value) => {
        window.clearTimeout(timeout)
        resolve(value)
      })
      .catch((error: unknown) => {
        window.clearTimeout(timeout)
        reject(error)
      })
  })
}

function normalizeKey(key: string | undefined) {
  return key?.trim().replace(/^['"]|['"]$/g, '')
}

function computeBuildingRadius(insights: SolarBuildingInsights | undefined) {
  const box = insights?.boundingBox
  if (!box) {
    return 30
  }

  const latMeters = Math.abs(box.ne.lat - box.sw.lat) * 111_320
  const avgLat = (box.ne.lat + box.sw.lat) / 2
  const lngMeters = Math.abs(box.ne.lng - box.sw.lng) * 111_320 * Math.cos((avgLat * Math.PI) / 180)
  const diagonal = Math.sqrt(latMeters ** 2 + lngMeters ** 2)
  return Math.ceil(diagonal * 0.65 + 6)
}

function formatPlacesError(error: unknown, referrerHints: string[] = getReferrerHints()) {
  const message = error instanceof Error ? error.message : String(error)

  if (
    message.includes('blocked') ||
    message.includes('AutocompletePlaces') ||
    message.includes('GetPlace') ||
    message.includes('PERMISSION_DENIED')
  ) {
    return [
      'Google blocked Places on this domain. Add ALL of these HTTP referrers to your API key:',
      referrerHints.join(' | '),
      'Production: https://3-droof.vercel.app/* and https://*.vercel.app/*',
      'Local: http://127.0.0.1:5173/* and http://localhost:5173/*',
    ].join(' ')
  }

  if (message.includes('has not been used') || message.includes('disabled')) {
    return `${message} Enable "Places API (New)" in the same project as your key, wait 2 minutes, then refresh.`
  }

  return message
}
