export type LatLng = {
  lat: number
  lng: number
}

export type AddressSuggestion = {
  placeId: string
  description: string
}

export type PlaceLocation = {
  address: string
  location: LatLng
}

export type GridData = {
  width: number
  height: number
  pixelSizeMeters: number
  values: Float32Array
  noDataValue?: number
}

export type SolarDataLayers = {
  dsmUrl?: string
  rgbUrl?: string
  maskUrl?: string
  annualFluxUrl?: string
  imageryQuality?: string
  imageryDate?: {
    year?: number
    month?: number
    day?: number
  }
}

export type SolarBuildingInsights = {
  name?: string
  imageryQuality?: string
  boundingBox?: {
    sw: LatLng
    ne: LatLng
  }
  solarPotential?: {
    roofSegmentStats?: unknown[]
    maxArrayPanelsCount?: number
    wholeRoofStats?: {
      areaMeters2?: number
      sunshineQuantiles?: number[]
    }
  }
}

export type SolarPackage = {
  place: PlaceLocation
  buildingInsights?: SolarBuildingInsights
  dataLayers?: SolarDataLayers
  dsmGrid?: GridData
  maskGrid?: GridData
}

export type RoofPlane = {
  id: string
  clusterId: number
  label: string
  letter: string
  color: string
  cellCount: number
  areaSqFt: number
  pitchDegrees: number
  azimuthDegrees: number
  centroid: {
    x: number
    y: number
    z: number
  }
}

export type ConfidenceLevel = 'high' | 'medium' | 'low'

export type ConfidenceResult = {
  level: ConfidenceLevel
  score: number
  reasons: string[]
  fallbackTriggers: string[]
}

export type RoofAnalysisResult = {
  grid: GridData
  maskGrid?: GridData
  planes: RoofPlane[]
  planeAssignments?: Int32Array
  meshSettings?: {
    baseZ: number
    scaleZ: number
    xOffset: number
    yOffset: number
  }
  totalAreaSqFt: number
  averagePitchDegrees: number
  confidence: ConfidenceResult
}

export type CostScenario = {
  propertiesPerMonth: number
  fallbackRatePercent: number
  fallbackReports: number
  googleOnlyMonthly: number
  fallbackMonthly: number
  blendedMonthly: number
}
