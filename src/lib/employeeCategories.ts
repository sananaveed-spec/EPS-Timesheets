import type { EmployeeCategory, ManagedUser } from '../types';

export const DEFAULT_FULL_TIME_SALARIED = [
  'Joe Prevendar',
  'Abdur Rehman',
  'Eric Pieper',
  'Chandler Hubbard',
  'Aatir Siddiqui',
  'Zulfi Aijaz',
  'Aamir Ali',
  'Muhammad Shaharyar',
] as const;

export const DEFAULT_FULL_TIME_HOURLY = [
  'Justin Ray',
  'Kathy',
  'William Bill Dearsan',
  'Ian Obermann',
  'jose.bravo',
  'Joni Pieper',
  'joshua.pieper',
] as const;

export const DEFAULT_PART_TIME_HOURLY = [
  'Aaron Nevarez',
  'Ashraf Alkiesoum',
  'Gary Bettencourt',
  'Han Luu',
  'Julian Sanchez',
  'mee.vang',
  'Tyler Smith',
  'julian.diaz',
  'luke.contreras',
] as const;

export function normalizeEmployeeName(employeeName: string): string {
  return employeeName
    .normalize('NFKC')
    .replace(/[\u00A0\u2000-\u200B\u202F\uFEFF]/g, ' ')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s*\[[^\]]*\]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable compare key so "Julian Sanchez" matches "Julian Sanchez (48)". */
export function employeeNameKey(employeeName: string): string {
  return normalizeEmployeeName(employeeName)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

export function sameEmployeeName(a: string, b: string): boolean {
  const left = normalizeEmployeeName(a).toLowerCase();
  const right = normalizeEmployeeName(b).toLowerCase();
  if (left === right) return true;
  const keyA = employeeNameKey(a);
  const keyB = employeeNameKey(b);
  return keyA.length > 0 && keyA === keyB;
}

function defaultUserId(name: string): string {
  return `default:${normalizeEmployeeName(name).toLowerCase()}`;
}

export function createDefaultManagedUsers(): ManagedUser[] {
  const users: ManagedUser[] = [
    ...DEFAULT_FULL_TIME_SALARIED.map((name) => ({
      id: defaultUserId(name),
      name,
      category: 'full-time-salaried' as EmployeeCategory,
    })),
    ...DEFAULT_FULL_TIME_HOURLY.map((name) => ({
      id: defaultUserId(name),
      name,
      category: 'full-time-hourly' as EmployeeCategory,
    })),
    ...DEFAULT_PART_TIME_HOURLY.map((name) => ({
      id: defaultUserId(name),
      name,
      category: 'part-time-hourly' as EmployeeCategory,
    })),
  ];

  return users;
}

export function mergeDefaultManagedUsers(
  existingUsers: ManagedUser[],
): ManagedUser[] {
  const merged = [...existingUsers];

  for (const defaultUser of createDefaultManagedUsers()) {
    const alreadyPresent = merged.some((user) =>
      sameEmployeeName(user.name, defaultUser.name),
    );
    if (!alreadyPresent) merged.push(defaultUser);
  }

  return merged;
}

export function alignUsersWithClockify(
  users: ManagedUser[],
  clockifyUsers: Array<{ id: string; name: string }>,
): ManagedUser[] {
  let changed = false;
  const nextUsers = users.map((user) => {
    const match =
      (user.clockifyUserId &&
        clockifyUsers.find((employee) => employee.id === user.clockifyUserId)) ||
      clockifyUsers.find((employee) =>
        sameEmployeeName(employee.name, user.name),
      );
    if (!match) return user;
    if (match.name === user.name && match.id === user.clockifyUserId) {
      return user;
    }
    changed = true;
    return { ...user, name: match.name, clockifyUserId: match.id };
  });
  return changed ? nextUsers : users;
}
