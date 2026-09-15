import type { OfficeCategory } from '../types';

export type { OfficeCategory };

export const OFFICE_CATEGORY_LABELS: Record<OfficeCategory, string> = {
  'eps-clovis-office': 'EPS Clovis Office',
  'eps-fresno-shop': 'EPS Fresno Shop',
};

/** Fixed location names used in description matching (miles / errands). */
export const OFFICE_LOCATION_NAMES = Object.values(OFFICE_CATEGORY_LABELS);

export function isOfficeCategory(value: unknown): value is OfficeCategory {
  return value === 'eps-clovis-office' || value === 'eps-fresno-shop';
}

export function officeCategoryFromLegacyName(
  name: string,
): OfficeCategory | null {
  const n = name.trim().toLowerCase();
  if (n.includes('clovis')) return 'eps-clovis-office';
  if (n.includes('fresno')) return 'eps-fresno-shop';
  return null;
}
