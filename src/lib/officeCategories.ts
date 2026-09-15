import type { OfficeCategory, OfficeMember } from '../types';
import { sameEmployeeName } from './employeeCategories';
import {
  alignOfficeMembersToClockify,
  type ClockifyPerson,
} from './clockifyPeople';

export const DEFAULT_OFFICE_NAMES = [
  'EPS Clovis Office',
  'EPS Fresno Shop',
] as const;

export function sameOfficeCategoryName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function createDefaultOfficeCategories(): OfficeCategory[] {
  return DEFAULT_OFFICE_NAMES.map((name) => ({
    id: crypto.randomUUID(),
    name,
    members: [],
  }));
}

export function mergeDefaultOfficeCategories(
  existing: OfficeCategory[],
): OfficeCategory[] {
  const next = existing.map((office) => ({
    ...office,
    members: Array.isArray(office.members) ? office.members : [],
  }));

  for (const name of DEFAULT_OFFICE_NAMES) {
    if (next.some((office) => sameOfficeCategoryName(office.name, name))) {
      continue;
    }
    next.push({ id: crypto.randomUUID(), name, members: [] });
  }

  return next;
}

/** @deprecated Prefer alignOfficeMembersToClockify — kept for call-site compatibility. */
export function alignOfficeMembersWithClockify(
  offices: OfficeCategory[],
  clockifyUsers: ClockifyPerson[],
  _managedUsers: { name: string }[] = [],
): OfficeCategory[] {
  return alignOfficeMembersToClockify(offices, clockifyUsers);
}

export function officeMemberNames(offices: OfficeCategory[]): string[] {
  const names: string[] = [];
  for (const office of offices) {
    for (const member of office.members) {
      if (member.name.trim()) names.push(member.name);
    }
  }
  return names;
}

export function findOfficeMember(
  offices: OfficeCategory[],
  memberId: string,
): { office: OfficeCategory; member: OfficeMember } | null {
  for (const office of offices) {
    const member = office.members.find((m) => m.id === memberId);
    if (member) return { office, member };
  }
  return null;
}

export function sameOfficeMember(
  a: { clockifyUserId?: string; name: string },
  b: { clockifyUserId?: string; name: string },
): boolean {
  if (a.clockifyUserId && b.clockifyUserId) {
    return a.clockifyUserId === b.clockifyUserId;
  }
  return sameEmployeeName(a.name, b.name);
}
