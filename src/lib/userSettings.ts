import type { ManagedUser, MentionUser, OfficeCategory } from '../types';
import { sameEmployeeName } from './employeeCategories';
import {
  DEFAULT_EMAIL_PRESETS,
  EMAIL_REPORT_OFFICES,
  type EmailReportOffice,
  type OfficeEmailPreset,
} from './emailTemplates';
import {
  normalizeOfficeCategory,
  officeCategoryFromLegacyName,
} from './officeCategories';

const STORAGE_KEY = 'clockify-converter-managed-users';
const MENTION_STORAGE_KEY = 'clockify-converter-mention-users';
const LEGACY_OFFICE_STORAGE_KEY = 'clockify-converter-office-categories';
const LEGACY_LOCATION_STORAGE_KEY = 'clockify-converter-managed-locations';
const OFFICE_FIELD_MIGRATED_KEY =
  'clockify-converter-managed-users-office-field-v1';
/** One-time clear of seeded Manage Users so the list starts empty. */
const CLEAR_SEEDED_USERS_KEY =
  'clockify-converter-managed-users-cleared-v1';

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

function normalizeManagedUser(raw: ManagedUser): ManagedUser | null {
  if (
    typeof raw?.id !== 'string' ||
    typeof raw?.name !== 'string' ||
    typeof raw?.category !== 'string'
  ) {
    return null;
  }

  const office =
    raw.office === null
      ? null
      : normalizeOfficeCategory(raw.office) ?? undefined;

  return {
    id: raw.id,
    name: raw.name,
    category: raw.category,
    ...(office !== undefined ? { office } : {}),
    ...(typeof raw.clockifyUserId === 'string'
      ? { clockifyUserId: raw.clockifyUserId }
      : {}),
  };
}

/**
 * One-time: copy affiliations from the old separate office-member lists
 * onto matching Manage Users records.
 */
function migrateOfficeMembersOntoManagedUsers(
  users: ManagedUser[],
): ManagedUser[] {
  if (typeof window === 'undefined') return users;
  if (window.localStorage.getItem(OFFICE_FIELD_MIGRATED_KEY) === '1') {
    return users;
  }

  type LegacyOffice = {
    name?: string;
    members?: Array<{ name?: string; clockifyUserId?: string }>;
  };

  const legacyOffices = readStoredList<LegacyOffice>(LEGACY_OFFICE_STORAGE_KEY);
  const byPerson = new Map<string, OfficeCategory>();

  for (const office of legacyOffices) {
    const affiliation = officeCategoryFromLegacyName(office.name ?? '');
    if (!affiliation || !Array.isArray(office.members)) continue;
    for (const member of office.members) {
      if (!member?.name) continue;
      const key = (member.clockifyUserId || member.name).toLowerCase();
      byPerson.set(key, affiliation);
      byPerson.set(member.name.toLowerCase(), affiliation);
    }
  }

  let changed = false;
  const next = users.map((user) => {
    if (user.office) return user;
    const byId = user.clockifyUserId
      ? byPerson.get(user.clockifyUserId.toLowerCase())
      : undefined;
    const byName = byPerson.get(user.name.toLowerCase());
    const match =
      byId ||
      byName ||
      [...byPerson.entries()].find(([k]) => sameEmployeeName(k, user.name))?.[1];
    if (!match) return user;
    changed = true;
    return { ...user, office: match };
  });

  window.localStorage.setItem(OFFICE_FIELD_MIGRATED_KEY, '1');
  window.localStorage.removeItem(LEGACY_OFFICE_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_LOCATION_STORAGE_KEY);

  if (changed) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  return next;
}

export function loadManagedUsers(): ManagedUser[] {
  if (typeof window === 'undefined') return [];

  // Wipe previously seeded / stored users once so Manage Users starts at 0.
  if (window.localStorage.getItem(CLEAR_SEEDED_USERS_KEY) !== '1') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
    window.localStorage.setItem(CLEAR_SEEDED_USERS_KEY, '1');
    window.localStorage.setItem(OFFICE_FIELD_MIGRATED_KEY, '1');
    window.localStorage.removeItem(LEGACY_OFFICE_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_LOCATION_STORAGE_KEY);
    return [];
  }

  const stored = readStoredList<ManagedUser>(STORAGE_KEY)
    .map(normalizeManagedUser)
    .filter((user): user is ManagedUser => user !== null);

  return migrateOfficeMembersOntoManagedUsers(stored);
}

export function saveManagedUsers(users: ManagedUser[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(users));
}

export function loadMentionUsers(): MentionUser[] {
  return readStoredList<MentionUser>(MENTION_STORAGE_KEY)
    .map((user) => {
      const office = normalizeOfficeCategory(user?.office);
      if (
        typeof user?.id !== 'string' ||
        typeof user?.name !== 'string' ||
        !office
      ) {
        return null;
      }
      return {
        id: user.id,
        name: user.name,
        office,
        ...(typeof user.clockifyUserId === 'string'
          ? { clockifyUserId: user.clockifyUserId }
          : {}),
      } satisfies MentionUser;
    })
    .filter((user): user is MentionUser => user != null);
}

export function saveMentionUsers(users: MentionUser[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(MENTION_STORAGE_KEY, JSON.stringify(users));
}

const EMAIL_PRESETS_STORAGE_KEY = 'clockify-converter-email-presets-v5';

export function loadEmailPresets(): Record<
  EmailReportOffice,
  OfficeEmailPreset
> {
  const defaults: Record<EmailReportOffice, OfficeEmailPreset> = {
    'eps-clovis-office': { ...DEFAULT_EMAIL_PRESETS['eps-clovis-office'] },
    'eps-fresno-shop': { ...DEFAULT_EMAIL_PRESETS['eps-fresno-shop'] },
  };
  if (typeof window === 'undefined') return defaults;

  try {
    const raw = window.localStorage.getItem(EMAIL_PRESETS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<
      Record<EmailReportOffice, Partial<OfficeEmailPreset>>
    >;
    for (const office of EMAIL_REPORT_OFFICES) {
      const saved = parsed[office];
      if (!saved) continue;
      defaults[office] = {
        office,
        from:
          typeof saved.from === 'string' && saved.from.trim()
            ? saved.from.trim()
            : defaults[office].from,
        to: Array.isArray(saved.to)
          ? saved.to.filter((e): e is string => typeof e === 'string')
          : defaults[office].to,
        cc: Array.isArray(saved.cc)
          ? saved.cc.filter((e): e is string => typeof e === 'string')
          : defaults[office].cc,
        greetingName:
          typeof saved.greetingName === 'string' && saved.greetingName.trim()
            ? saved.greetingName.trim()
            : defaults[office].greetingName,
        senderFirstName:
          typeof saved.senderFirstName === 'string' &&
          saved.senderFirstName.trim()
            ? saved.senderFirstName.trim()
            : defaults[office].senderFirstName,
      };
    }
  } catch {
    /* keep defaults */
  }
  return defaults;
}

export function saveEmailPreset(preset: OfficeEmailPreset): void {
  if (typeof window === 'undefined') return;
  const all = loadEmailPresets();
  all[preset.office] = {
    office: preset.office,
    from: preset.from,
    to: preset.to,
    cc: preset.cc,
    greetingName: preset.greetingName,
    senderFirstName: preset.senderFirstName,
  };
  window.localStorage.setItem(EMAIL_PRESETS_STORAGE_KEY, JSON.stringify(all));
}
