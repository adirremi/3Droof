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

export type RoofSegmentStats = {
  pitchDegrees?: number
  azimuthDegrees?: number
  stats?: {
    areaMeters2?: number
    groundAreaMeters2?: number
  }
  center?: LatLng
  boundingBox?: {
    sw: LatLng
    ne: LatLng
  }
  planeHeightAtCenterMeters?: number
}

export type SolarBuildingInsights = {
  name?: string
  imageryQuality?: string
  center?: LatLng
  boundingBox?: {
    sw: LatLng
    ne: LatLng
  }
  solarPotential?: {
    roofSegmentStats?: RoofSegmentStats[]
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

export type PlaneEquation = {
  cxMeters: number
  cyMeters: number
  cz: number
  nx: number
  ny: number
  nz: number
}

export type Point2D = {
  x: number
  y: number
}

export type Point3D = {
  x: number
  y: number
  z: number
}

export type RoofPlane = {
  id: string
  clusterId: number
  label: string
  letter: string
  color: string
  cellCount: number
  areaSqFt: number
  groundAreaSqFt: number
  pitchDegrees: number
  azimuthDegrees: number
  centroid: Point3D
  planeEquation?: PlaneEquation
  polygon3D?: Point3D[]
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
  cellsByPlane?: Int32Array[]
  meshSettings?: {
    baseZ: number
    scaleZ: number
    xOffset: number
    yOffset: number
  }
  totalAreaSqFt: number
  totalGroundAreaSqFt: number
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
