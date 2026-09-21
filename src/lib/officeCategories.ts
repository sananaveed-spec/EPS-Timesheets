import type { OfficeCategory } from '../types';

export type { OfficeCategory };

export const OFFICE_CATEGORY_LABELS: Record<OfficeCategory, string> = {
  'eps-employees': 'EPS Employees',
  'eps-clovis-office': 'EPS Clovis Office',
  'eps-fresno-shop': 'EPS Fresno Shop',
};

/** Fixed location names used in description matching (miles / errands). */
export const OFFICE_LOCATION_NAMES = Object.values(OFFICE_CATEGORY_LABELS);

export function isOfficeCategory(value: unknown): value is OfficeCategory {
  return (
    value === 'eps-employees' ||
    value === 'eps-clovis-office' ||
    value === 'eps-fresno-shop'
  );
}

/** Normalize stored ids (including short-lived `eps-office` rename). */
export function normalizeOfficeCategory(value: unknown): OfficeCategory | null {
  if (value === 'eps-office') return 'eps-employees';
  if (isOfficeCategory(value)) return value;
  return null;
}

export function officeCategoryFromLegacyName(
  name: string,
): OfficeCategory | null {
  const n = name.trim().toLowerCase();
  if (n.includes('clovis')) return 'eps-clovis-office';
  if (n.includes('fresno')) return 'eps-fresno-shop';
  if (
    n.includes('eps employees') ||
    n === 'eps office' ||
    n.includes('eps office')
  ) {
    return 'eps-employees';
  }
  return null;
}
