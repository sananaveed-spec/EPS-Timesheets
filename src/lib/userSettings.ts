import type { OfficeCategory, ManagedUser, MentionUser } from '../types';
import {
  createDefaultOfficeCategories,
  mergeDefaultOfficeCategories,
} from './officeCategories';
import { mergeDefaultManagedUsers } from './employeeCategories';

const STORAGE_KEY = 'clockify-converter-managed-users';
const MENTION_STORAGE_KEY = 'clockify-converter-mention-users';
const OFFICE_STORAGE_KEY = 'clockify-converter-office-categories';
const LEGACY_LOCATION_STORAGE_KEY = 'clockify-converter-managed-locations';
const DEFAULTS_MERGED_KEY =
  'clockify-converter-managed-users-defaults-merged-v1';
const OFFICE_DEFAULTS_MERGED_KEY =
  'clockify-converter-office-categories-defaults-merged-v1';
/** One-time wipe of generic EPS Office / EPS Offices category names. */
const REMOVE_EPS_OFFICE_KEY =
  'clockify-converter-remove-eps-office-category-v2';

/** Exact generic labels only — never match "EPS Clovis Office" etc. */
function isGenericEpsOfficeName(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return n === 'eps office' || n === 'eps offices';
}

function stripGenericEpsOffice(offices: OfficeCategory[]): OfficeCategory[] {
  return offices.filter((office) => !isGenericEpsOfficeName(office.name));
}

function readStoredList<T>(key: string): T[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeOfficeCategories(raw: unknown[]): OfficeCategory[] {
  return raw
    .map((item) => {
      const office = item as OfficeCategory;
      if (typeof office?.id !== 'string' || typeof office?.name !== 'string') {
        return null;
      }
      const members = Array.isArray(office.members)
        ? office.members
            .filter(
              (m) => typeof m?.id === 'string' && typeof m?.name === 'string',
            )
            .map((m) => ({
              id: m.id,
              name: m.name,
              ...(typeof m.clockifyUserId === 'string'
                ? { clockifyUserId: m.clockifyUserId }
                : {}),
            }))
        : [];
      return { id: office.id, name: office.name, members };
    })
    .filter((office): office is OfficeCategory => office !== null);
}

function migrateLegacyLocations(): OfficeCategory[] {
  const legacy = readStoredList<{ id: string; name: string }>(
    LEGACY_LOCATION_STORAGE_KEY,
  ).filter((loc) => typeof loc?.name === 'string');

  if (legacy.length === 0) return [];

  return legacy.map((loc) => ({
    id: typeof loc.id === 'string' ? loc.id : crypto.randomUUID(),
    name: loc.name,
    members: [],
  }));
}

export function loadOfficeCategories(): OfficeCategory[] {
  let stored = normalizeOfficeCategories(
    readStoredList<OfficeCategory>(OFFICE_STORAGE_KEY),
  );

  if (typeof window === 'undefined') {
    return mergeDefaultOfficeCategories(stripGenericEpsOffice(stored));
  }

  if (stored.length === 0) {
    const migrated = migrateLegacyLocations();
    if (migrated.length > 0) stored = migrated;
  }

  stored = stripGenericEpsOffice(stored);

  // Also strip from the older location key so it cannot remigrate later.
  const legacy = readStoredList<{ id: string; name: string }>(
    LEGACY_LOCATION_STORAGE_KEY,
  );
  if (legacy.some((loc) => isGenericEpsOfficeName(loc.name ?? ''))) {
    window.localStorage.setItem(
      LEGACY_LOCATION_STORAGE_KEY,
      JSON.stringify(
        legacy.filter((loc) => !isGenericEpsOfficeName(loc.name ?? '')),
      ),
    );
  }

  if (window.localStorage.getItem(REMOVE_EPS_OFFICE_KEY) !== '1') {
    window.localStorage.setItem(REMOVE_EPS_OFFICE_KEY, '1');
  }

  const alreadyMerged =
    window.localStorage.getItem(OFFICE_DEFAULTS_MERGED_KEY) === '1';
  const seeded =
    alreadyMerged && stored.length > 0
      ? stored
      : stored.length > 0
        ? mergeDefaultOfficeCategories(stored)
        : createDefaultOfficeCategories();

  // Always persist the cleaned list so a stale React save cannot resurrect it.
  window.localStorage.setItem(OFFICE_DEFAULTS_MERGED_KEY, '1');
  window.localStorage.setItem(OFFICE_STORAGE_KEY, JSON.stringify(seeded));
  return seeded;
}

export function saveOfficeCategories(offices: OfficeCategory[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(
    OFFICE_STORAGE_KEY,
    JSON.stringify(stripGenericEpsOffice(offices)),
  );
}

export function isGenericEpsOfficeCategoryName(name: string): boolean {
  return isGenericEpsOfficeName(name);
}

export function loadManagedUsers(): ManagedUser[] {
  const stored = readStoredList<ManagedUser>(STORAGE_KEY)
    .filter(
      (user) =>
        typeof user?.id === 'string' &&
        typeof user?.name === 'string' &&
        typeof user?.category === 'string',
    )
    .map((user) => ({
      id: user.id,
      name: user.name,
      category: user.category,
      ...(typeof user.clockifyUserId === 'string'
        ? { clockifyUserId: user.clockifyUserId }
        : {}),
    }));

  if (typeof window === 'undefined') {
    return mergeDefaultManagedUsers(stored);
  }

  const alreadyMerged = window.localStorage.getItem(DEFAULTS_MERGED_KEY) === '1';
  if (alreadyMerged && stored.length > 0) return stored;

  const seeded = mergeDefaultManagedUsers(stored);
  window.localStorage.setItem(DEFAULTS_MERGED_KEY, '1');
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
  return seeded;
}

export function saveManagedUsers(users: ManagedUser[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(users));
}

export function loadMentionUsers(): MentionUser[] {
  return readStoredList<MentionUser>(MENTION_STORAGE_KEY)
    .filter((user) => typeof user?.id === 'string' && typeof user?.name === 'string')
    .map((user) => ({
      id: user.id,
      name: user.name,
      ...(typeof user.clockifyUserId === 'string'
        ? { clockifyUserId: user.clockifyUserId }
        : {}),
    }));
}

export function saveMentionUsers(users: MentionUser[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(MENTION_STORAGE_KEY, JSON.stringify(users));
}
