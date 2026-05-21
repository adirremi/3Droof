import type { CostScenario } from '../types'

const GOOGLE_PLACES_PER_PROPERTY_USD = 0.01
const GOOGLE_SOLAR_BUILDING_INSIGHTS_USD = 0.03
const GOOGLE_SOLAR_DATA_LAYERS_USD = 0.12
const GOOGLE_TILE_AND_VIEWER_OVERHEAD_USD = 0.02
const COMMERCIAL_ROOF_REPORT_USD = 28

export function getCostScenario(
  propertiesPerMonth: number,
  fallbackRatePercent: number,
): CostScenario {
  const normalizedProperties = Math.max(0, Math.round(propertiesPerMonth || 0))
  const normalizedFallbackRate = Math.max(0, Math.min(100, fallbackRatePercent || 0))
  const fallbackReports = Math.ceil(normalizedProperties * (normalizedFallbackRate / 100))
  const googleOnlyMonthly =
    normalizedProperties *
    (GOOGLE_PLACES_PER_PROPERTY_USD +
      GOOGLE_SOLAR_BUILDING_INSIGHTS_USD +
      GOOGLE_SOLAR_DATA_LAYERS_USD +
      GOOGLE_TILE_AND_VIEWER_OVERHEAD_USD)
  const fallbackMonthly = fallbackReports * COMMERCIAL_ROOF_REPORT_USD

  return {
    propertiesPerMonth: normalizedProperties,
    fallbackRatePercent: normalizedFallbackRate,
    fallbackReports,
    googleOnlyMonthly,
    fallbackMonthly,
    blendedMonthly: googleOnlyMonthly + fallbackMonthly,
  }
}
